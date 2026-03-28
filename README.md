# unoapi-voip-service

Servico auxiliar para conectar a UnoAPI ao modulo `@w3nder/whatsapp-voip-wasm`.

## Objetivo

- Manter a UnoAPI como dona da sessao Baileys
- Isolar o motor VoIP em outro processo
- Receber eventos de chamada da UnoAPI
- Devolver comandos de signaling para a UnoAPI enviar no socket Baileys

## Fluxo proposto

1. A UnoAPI recebe evento `call` no Baileys.
2. A UnoAPI envia o evento para este servico.
3. O servico processa o estado da chamada e aciona o motor VoIP.
4. Quando o motor VoIP precisar enviar signaling, este servico devolve comandos no JSON de resposta.
5. A UnoAPI usa a sessao Baileys existente para enviar o stanza `call`.
6. Quando a UnoAPI receber signaling bruto do socket, ela chama `/v1/calls/signaling`.
7. A resposta de `/signaling` tambem pode devolver comandos para a UnoAPI executar.

## Endpoints iniciais

- `GET /health`
- `POST /v1/calls/events`
- `POST /v1/calls/signaling`
- `GET /v1/sessions/:session/calls/:callId`

## Contrato de retorno para a UnoAPI

O servico devolve a comunicacao de volta para a UnoAPI no proprio corpo da resposta HTTP.

Importante:

- o `unoapi-voip-service` nao precisa conhecer a URL da UnoAPI
- hoje nao existe `UNOAPI_URL` neste projeto
- a UnoAPI inicia a comunicacao chamando este servico
- a resposta volta na mesma requisicao HTTP
- por isso a UnoAPI precisa de `VOIP_SERVICE_URL`, mas o servico de VoIP nao precisa de uma URL da UnoAPI

Modelo atual:

- `UnoAPI -> POST /v1/calls/events -> unoapi-voip-service`
- `unoapi-voip-service -> HTTP response { state, commands[] } -> UnoAPI`
- `UnoAPI -> executa commands[] no socket Baileys`

Este projeto so precisaria conhecer a URL da UnoAPI em uma arquitetura diferente, por exemplo:

- callback HTTP assincrono
- websocket entre os dois servicos
- fila/pubsub com workers separados

Formato de retorno de `POST /v1/calls/events`:

```json
{
  "state": {
    "session": "5566996269251",
    "callId": "abc123",
    "from": "123456789012345@lid",
    "callerPn": "556696923653@s.whatsapp.net",
    "isVideo": false,
    "lastEvent": "incoming_call",
    "updatedAt": 1774650364000
  },
  "commands": [
    {
      "action": "send_call_node",
      "session": "5566996269251",
      "callId": "abc123",
      "peerJid": "123456789012345@lid",
      "payloadBase64": "PGNhbGwgdG89IjEyMzQ1Njc4OTAxMjM0NUBsaWQiPjxvZmZlciBjYWxsLWlkPSJhYmMxMjMiLz48L2NhbGw+",
      "payloadTag": "call"
    }
  ]
}
```

Formato de retorno de `POST /v1/calls/signaling`:

```json
{
  "state": {
    "session": "5566996269251",
    "callId": "abc123",
    "from": "123456789012345@lid",
    "lastEvent": "incoming_call",
    "updatedAt": 1774650364000
  },
  "commands": [
    {
      "action": "send_call_node",
      "session": "5566996269251",
      "callId": "abc123",
      "peerJid": "123456789012345@lid",
      "payloadBase64": "PGNhbGwgdG89IjEyMzQ1Njc4OTAxMjM0NUBsaWQiPjxhY2NlcHQgY2FsbC1pZD0iYWJjMTIzIi8+PC9jYWxsPg==",
      "payloadTag": "call"
    }
  ]
}
```

Regras praticas:

- `commands` e sempre um array
- quando nao houver nada para a Uno executar, o servico pode devolver `[]`
- `send_call_node` e o comando principal para a Uno reenviar signaling no socket Baileys
- `payloadBase64` carrega o stanza ou fragmento XML gerado pelo motor VoIP
- a Uno prioriza enviar o stanza completo do WASM quando ele vier com root `call`

## Exemplos ponta a ponta

### 1. Evento de chamada enviado pela UnoAPI

Request:

```json
{
  "session": "5566996269251",
  "event": "incoming_call",
  "callId": "abc123",
  "from": "123456789012345@lid",
  "callerPn": "556696923653@s.whatsapp.net",
  "isVideo": false,
  "timestamp": 1774650364
}
```

Response:

```json
{
  "state": {
    "session": "5566996269251",
    "callId": "abc123",
    "from": "123456789012345@lid",
    "callerPn": "556696923653@s.whatsapp.net",
    "isVideo": false,
    "lastEvent": "incoming_call",
    "updatedAt": 1774650364000
  },
  "commands": [
    {
      "action": "send_call_node",
      "session": "5566996269251",
      "callId": "abc123",
      "peerJid": "123456789012345@lid",
      "payloadBase64": "PGNhbGwgdG89IjEyMzQ1Njc4OTAxMjM0NUBsaWQiPjxvZmZlciBjYWxsLWlkPSJhYmMxMjMiLz48L2NhbGw+",
      "payloadTag": "call"
    }
  ]
}
```

### 2. Signaling bruto enviado pela UnoAPI

Request:

```json
{
  "session": "5566996269251",
  "callId": "abc123",
  "peerJid": "123456789012345@lid",
  "msgType": "offer",
  "payload": "<offer call-id=\"abc123\" call-creator=\"123456789012345@lid\"/>",
  "timestamp": 1774650364
}
```

Response:

```json
{
  "state": {
    "session": "5566996269251",
    "callId": "abc123",
    "from": "123456789012345@lid",
    "lastEvent": "incoming_call",
    "updatedAt": 1774650364000
  },
  "commands": [
    {
      "action": "send_call_node",
      "session": "5566996269251",
      "callId": "abc123",
      "peerJid": "123456789012345@lid",
      "payloadBase64": "PGNhbGwgdG89IjEyMzQ1Njc4OTAxMjM0NUBsaWQiPjxhY2NlcHQgY2FsbC1pZD0iYWJjMTIzIi8+PC9jYWxsPg==",
      "payloadTag": "call"
    }
  ]
}
```

## Configuracao

No servico novo, os envs ficam assim:

- `PORT`: porta HTTP do servico. Padrao `3097`
- `VOIP_SERVICE_TOKEN`: bearer token interno aceito nas rotas `/v1/*`

Exemplo:

```env
PORT=3097
VOIP_SERVICE_TOKEN=change-me
```

Na UnoAPI, os envs correspondentes ficam assim:

```env
VOIP_SERVICE_URL=http://localhost:3097
VOIP_SERVICE_TOKEN=change-me
VOIP_SERVICE_TIMEOUT_MS=3000
```

Observacao:

- `GET /health` continua aberto sem token
- as rotas `/v1/*` exigem `Authorization: Bearer <VOIP_SERVICE_TOKEN>` quando o token estiver configurado

## Docker e Portainer

Este projeto agora possui arquivos basicos para containerizacao seguindo o estilo da UnoAPI:

- `Dockerfile`
- `docker-compose.portainer.yml`

Uso local com Docker:

```bash
docker build -t unoapi-voip-service .
docker run --rm -p 3097:3097 \
  -e PORT=3097 \
  -e VOIP_SERVICE_TOKEN=change-me \
  unoapi-voip-service
```

Uso no Portainer:

1. Crie uma stack apontando para este projeto.
2. Use o arquivo `docker-compose.portainer.yml`.
3. Defina ao menos:
   - `PORT`
   - `VOIP_SERVICE_TOKEN`

Exemplo de variaveis para a stack:

```env
PORT=3097
VOIP_SERVICE_TOKEN=change-me
```

Observacao importante:

- neste momento o container expoe apenas a porta HTTP `3097`
- o plano de controle e signaling ja esta integrado
- o plano de midia real (audio/relay/UDP) ainda nao foi implementado neste servico
- entao ainda nao faz sentido abrir portas UDP de audio no compose atual

## Integracao com `@w3nder/whatsapp-voip-wasm`

O projeto ja possui um adaptador em:

- `src/services/w3nder_adapter.ts`
- `src/vendor/w3nder-whatsapp-voip-wasm`

Ele faz:

- uso local vendor do wrapper e dos recursos WASM
- bootstrap por sessao
- `initialize()`
- `initVoipStack()`
- captura de `onSignalingXmpp`
- devolucao de comandos `send_call_node`

## Observacao

O wrapper e os recursos do pacote foram vendorados localmente para evitar dependencia de GitHub Packages no deploy.
O build copia `worker-bootstrap.js`, `loader.js`, `worker-modules.js` e `whatsapp.wasm` para `dist/`.
