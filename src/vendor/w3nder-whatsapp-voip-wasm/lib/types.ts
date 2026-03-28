/**
 * Tipos para o módulo WhatsApp VoIP WASM
 * 
 * Baseado na interface WAWebVoipStackInterfaceWeb do WhatsApp Web
 */

// ============================================================
// CONFIGURAÇÃO
// ============================================================

export interface AudioConfig {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  framesPerChunk: number;
}

export interface VideoConfig {
  cameraId?: string;
  width: number;
  height: number;
  maxFps: number;
}

export interface VideoFrame {
  userJid: string;
  frameBuffer: Uint8Array;
  width: number;
  height: number;
  orientation: number;
  format: number;
  timestamp: number;
  isKeyFrame: boolean;
}

// ============================================================
// CALLBACKS - O WASM chama essas funções
// ============================================================

export interface VoipCallbacks {
  // ================== SIGNALING ==================
  /**
   * Chamado quando o WASM precisa enviar signaling XMPP
   * Você deve enviar isso via socket do Baileys
   */
  onSignalingXmpp?: (peerJid: string, callId: string, xmlPayload: Uint8Array) => void | Promise<void>;
  
  // ================== EVENTOS DE CHAMADA ==================
  /**
   * Chamado quando ocorre um evento de chamada
   * eventType corresponde ao enum CallEvent do WhatsApp
   * 
   * Eventos importantes:
   * - 1: CallStateChanged
   * - 3: RingingStarted
   * - 4: RingingEnded
   * - 100: CallEnded
   * - 156: RelayListUpdate (lista de relays STUN/TURN)
   * - etc.
   */
  onCallEvent?: (eventType: number, eventData?: string) => void;
  
  /**
   * Chamado quando o VoIP stack está pronto
   */
  onVoipReady?: () => void;
  
  // ================== REDE ==================
  /**
   * Chamado quando o WASM precisa enviar dados para um relay
   * O SctpConnectionManager usa isso internamente
   */
  sendDataToRelay?: (data: Uint8Array, ip: string, port: number) => number;
  
  // ================== LOGGING ==================
  /**
   * Chamado para logs do WASM
   * level: 'error' | 'warn' | 'log' | 'debug'
   */
  onLog?: (level: string, message: string) => void;
  
  // ================== ÁUDIO CAPTURA ==================
  /**
   * Chamado quando o driver de captura de áudio é inicializado
   * Contém configuração do áudio (sample rate, channels, etc.)
   */
  onAudioCaptureInit?: (config: AudioConfig) => void;
  
  /**
   * Chamado quando a captura de áudio deve iniciar
   * Você deve começar a fornecer dados de áudio via sendAudioData()
   */
  onAudioCaptureStart?: () => void;
  
  /**
   * Chamado quando a captura de áudio deve parar
   */
  onAudioCaptureStop?: () => void;
  
  // ================== ÁUDIO PLAYBACK ==================
  /**
   * Chamado quando o driver de playback de áudio é inicializado
   */
  onAudioPlaybackInit?: (config: AudioConfig) => void;
  
  /**
   * Chamado quando o playback de áudio deve iniciar
   */
  onAudioPlaybackStart?: () => void;
  
  /**
   * Chamado quando o playback de áudio deve parar
   */
  onAudioPlaybackStop?: () => void;
  
  /**
   * Chamado quando há dados de áudio para reproduzir
   * Dados em Float32Array normalizados (-1.0 a 1.0)
   */
  onAudioPlaybackData?: (audioData: Float32Array) => void;
  
  // ================== VÍDEO CAPTURA ==================
  /**
   * Chamado quando a captura de vídeo deve iniciar
   */
  onVideoCaptureStart?: (config: VideoConfig) => void;
  
  /**
   * Chamado quando a captura de vídeo deve parar
   */
  onVideoCaptureStop?: () => void;
  
  /**
   * Chamado quando há um frame de vídeo do peer para renderizar
   */
  onVideoFrame?: (frame: VideoFrame) => void;
  
  // ================== DESKTOP SHARING ==================
  /**
   * Chamado quando o compartilhamento de tela deve iniciar
   */
  onDesktopCaptureStart?: (config: VideoConfig) => void;
  
  /**
   * Chamado quando o compartilhamento de tela deve parar
   */
  onDesktopCaptureStop?: () => void;
  
  // ================== CRYPTO ==================
  /**
   * HKDF - Extract and Expand
   * Usado para derivação de chaves
   */
  cryptoHkdf?: (key: Uint8Array, salt: Uint8Array | null, info: Uint8Array, length: number) => Uint8Array;
  
  /**
   * HMAC-SHA256
   * Usado para assinaturas
   */
  hmacSha256?: (data: Uint8Array, key: Uint8Array) => Uint8Array;
  
  // ================== CONTATOS ==================
  /**
   * Verifica se um participante é um contato conhecido
   * Usado para verificações de privacidade
   */
  isParticipantKnownContact?: (jid: string) => boolean;
}

// ============================================================
// OPÇÕES DE CONFIGURAÇÃO
// ============================================================

export interface VoipOptions {
  /** Intervalo de heartbeat em segundos (padrão: 30) */
  heartbeatInterval?: number;
  
  /** Timeout do lobby em minutos (padrão: 5) */
  lobbyTimeout?: number;
  
  /** Máximo de participantes para screen share (padrão: 32) */
  maxParticipantsScreenShare?: number;
  
  /** Máximo tamanho do grupo para ringtone longo (padrão: 32) */
  maxGroupSizeLongRingtone?: number;
  
  /** Habilita decoder de vídeo passthrough (padrão: false) */
  enablePassthroughVideoDecoder?: boolean;
}

export interface VoipConfig {
  /** Caminho para o arquivo WASM (opcional - usa wasm-resources/whatsapp.wasm por padrão) */
  wasmPath?: string;
  
  /** Caminho para a pasta de recursos (opcional - usa __dirname por padrão) */
  resourcesPath?: string;
  
  /** Callbacks que serão chamados pelo WASM */
  callbacks?: VoipCallbacks;
  
  /** Opções de configuração */
  options?: VoipOptions;
  
  /** Habilita/desabilita logs do WASM e callbacks (padrão: true) */
  enableLogs?: boolean;
}

// ============================================================
// CHAMADAS - Opções para iniciar chamadas
// ============================================================

export interface StartCallOptions {
  /** LID do destinatário (quem RECEBE) */
  peerJid: string;
  
  /** Lista de peers (para group calls) */
  peerList?: string[];
  
  /** ID único da chamada (gerado pelo caller) */
  callId: string;
  
  /** true para chamada de vídeo, false para áudio */
  isVideo: boolean;
  
  /** CRÍTICO: PN (phone number JID) do PEER (quem RECEBE) */
  peerPn: string;
  
  /** true se apenas áudio (mesmo em chamada de vídeo) */
  isAudioOnly?: boolean;
  
  /** true se for chamada em grupo */
  isGroupCall?: boolean;
  
  /** Dados extras (TC Token, etc.) */
  extraData?: Uint8Array;
}

export interface StartGroupCallOptions {
  /** Lista de JIDs dos peers */
  peerJids: string[];
  
  /** Lista de JIDs pendentes */
  pendingPeerJids: string[];
  
  /** Lista de JIDs convidados */
  inviteePeerJids: string[];
  
  /** ID único da chamada */
  callId: string;
  
  /** true para chamada de vídeo */
  isVideo: boolean;
  
  /** JID do próprio usuário */
  selfJid: string;
  
  /** true se apenas áudio */
  isAudioOnly: boolean;
  
  /** JID do grupo (se for chamada de grupo) */
  groupJid: string;
  
  /** JID do criador da chamada */
  callCreatorJid: string;
  
  /** true se for rejoin forçado */
  isForcedRejoin: boolean;
  
  /** true se for videoconferência */
  isVideoConference: boolean;
  
  /** Epoch ID (opcional) */
  epochId?: number;
  
  /** Contagem de convidados via call link (opcional) */
  callLinkInviteeCount?: number;
  
  /** Token do call link (opcional) */
  callLinkToken?: string;
}

export interface JoinOngoingCallOptions {
  /** ID da chamada */
  callId: string;
  
  /** JID do grupo (se aplicável) */
  groupJid: string;
  
  /** JID do criador da chamada */
  callCreatorJid: string;
  
  /** Lista de JIDs dos peers */
  peerJids: string[];
  
  /** Lista de JIDs pendentes */
  pendingPeerJids: string[];
  
  /** Lista de JIDs convidados */
  inviteePeerJids: string[];
  
  /** true para chamada de vídeo */
  isVideo: boolean;
  
  /** JID do próprio usuário */
  selfJid: string;
  
  /** true se apenas áudio */
  isAudioOnly: boolean;
  
  /** Bytes do offer (ou null) */
  offerBytes: Uint8Array | null;
  
  /** Tamanho do grupo */
  groupSize: number;
  
  /** JID de quem convidou */
  invitedByJid: string;
  
  /** true se for videoconferência */
  isVideoConference: boolean;
  
  /** true se for rejoin forçado */
  isForcedRejoin: boolean;
  
  /** Epoch ID */
  epochId: number;
  
  /** TC Token (opcional) */
  tcToken?: Uint8Array;
}

// ============================================================
// SIGNALING - Mensagens de sinalização
// ============================================================

export interface SignalingMessage {
  /** Payload em base64 do nó WAP */
  payload: string;
  
  /** JID do peer */
  peerJid?: string;
  
  /** JID do remetente */
  senderJid?: string;
  
  /** JID do criador da chamada */
  callCreator?: string;
  
  /** Número de sequência */
  seqNum?: string;
  
  /** Número de sequência do ACK */
  ackSeqNum?: string;
  
  /** Tipo da mensagem (offer, answer, etc.) */
  msgType?: string;
  
  /** Timestamp */
  timestamp?: string;
  
  /** Se é uma retransmissão */
  isRetry?: boolean;
  
  /** Dados extras (string) */
  extra?: string;
  
  /** Dados extras em bytes (TC Token) */
  extraData?: Uint8Array;
}

export interface SignalingOfferMessage {
  /** Payload em base64 do nó WAP completo */
  payload: string;
  
  /** Plataforma do peer (0 = unknown, 1 = android, 2 = ios, etc.) */
  peerPlatform?: number;
  
  /** Versão do app do peer */
  peerAppVersion?: string;
  
  /** Campo 'e' do offer (epoch) */
  epochId?: string;
  
  /** Campo 't' do offer (timestamp) */
  timestamp?: string;
  
  /** Se é chamada offline */
  isOffline?: boolean;
  
  /** Se é contato conhecido */
  isContact?: boolean;
  
  /** JID do peer */
  peerJid: string;
  
  /** TC Token (opcional) */
  tcToken?: Uint8Array;
}

export interface SignalingAckMessage {
  /** Payload em base64 */
  payload: string;
  
  /** Código de erro (normalmente "0" para sucesso) */
  errorCode?: string;
  
  /** Tipo da mensagem */
  msgType?: string;
  
  /** Dados extras */
  extraData?: Uint8Array;
}

// ============================================================
// INFORMAÇÕES DA CHAMADA
// ============================================================

export interface CallInfo {
  /** Modo AEC */
  aec_mode?: number;
  
  /** Duração do áudio em segundos */
  audio_duration?: number;
  
  /** Bytes recebidos */
  bytes_received?: number;
  
  /** Bytes enviados */
  bytes_sent?: number;
  
  /** Duração ativa da chamada */
  call_active_duration?: number;
  
  /** Duração total da chamada */
  call_duration?: number;
  
  /** Razão do fim da chamada */
  call_end_reason?: number;
  
  /** ID da chamada */
  call_id?: string;
  
  /** Se é chamada de vídeo */
  is_video_call?: boolean;
  
  /** JID do peer */
  peer_jid?: string;
  
  /** Campos adicionais */
  [key: string]: any;
}

// ============================================================
// ENUMS - Extraídos diretamente de WAWebVoipWaCallEnums
// Fonte: wsam/src/rsrc.php/v4i4bT4/yy/l/pt_BR-j/qHRoSxVr8B6.js
// ============================================================

/**
 * Enum de tipos de eventos de chamada
 * Extraído de WAWebVoipWaCallEnums.CallEvent
 */
export enum CallEventType {
  None = 0,
  CallOfferSent = 1,
  CallOfferReceived = 2,
  CallOfferAcked = 3,
  CallOfferNacked = 4,
  CallOfferReceiptReceived = 5,
  CallAcceptFailed = 6,
  CallAcceptSent = 7,
  CallAcceptReceived = 8,
  CallPreacceptReceived = 9,
  CallTerminateReceived = 10,
  CallRejectReceived = 11,
  CallOfferResend = 12,
  AudioStreamStarted = 13,
  P2PNegotiationSuccess = 14,
  RelayCreateSuccess = 15,
  CallStateChanged = 16,
  P2PNegotiationFailed = 17,
  MediaStreamError = 18,
  AudioInitError = 19,
  NoSamplingRatesForAudioRecord = 20,
  SendOfferFailed = 21,
  HandleOfferFailed = 22,
  SendAcceptFailed = 23,
  HandlePreAcceptFailed = 24,
  HandleAcceptFailed = 25,
  WillCreateSoundPort = 26,
  SoundPortCreateFailed = 27,
  TransportCandSendFailed = 28,
  P2PTransportCreateFailed = 29,
  P2PTransportMediaCreateFailed = 30,
  P2PTransportStartFailed = 31,
  P2PTransportRestartSuccess = 32,
  MissingRelayInfo = 33,
  ErrorGatheringHostCandidates = 34,
  MediaStreamStartError = 35,
  RelayLatencySendFailed = 36,
  RelayElectionSendFailed = 37,
  CallEnding = 38,
  CallCaptureBufferFilled = 39,
  CallCaptureEnded = 40,
  RxTimeout = 41,
  TxTimeout = 42,
  RxTrafficStarted = 43,
  RxTrafficStopped = 44,
  RTCPPacketReceived = 45,
  RTCPByeReceived = 46,
  RelayBindsFailed = 47,
  SoundPortCreated = 48,
  AudioDriverRestart = 49,
  Echo = 50,
  SelfVideoStateChanged = 51,
  PeerVideoStateChanged = 52,
  VideoPortCreated = 53,
  VideoPortCreateFailed = 54,
  VideoDecodeStarted = 55,
  VideoRenderStarted = 56,
  VideoCaptureStarted = 57,
  VideoPreviewFailed = 58,
  VideoPreviewReady = 59,
  VideoPreviewShouldMinimize = 60,
  VideoStreamCreateError = 61,
  VideoRenderFormatChanged = 62,
  VideoCodecMismatch = 63,
  VideoDecodePaused = 64,
  VideoDecodeResumed = 65,
  VideoEncodeFatalError = 66,
  VideoDecodeFatalError = 67,
  BatteryLevelLow = 68,
  PeerBatteryLevelLow = 69,
  GroupInfoChanged = 70,
  FieldstatsReady = 71,
  CallWaitingStateChanged = 72,
  MuteStateChanged = 73,
  InterruptionStateChanged = 74,
  RxTrafficStateForPeerChanged = 75,
  HandleAcceptReceiptFailed = 76,
  GroupParticipantLeft = 77,
  AudioRouteChangeRequest = 78,
  HandleAcceptAckFailed = 79,
  CallMissed = 80,
  WeakWiFiSwitchedToCellular = 81,
  CallAutoConnect = 82,
  RejectedDecryptionFailure = 83,
  PeerDeviceOrientationChanged = 84,
  HandleOfferAckFailed = 85,
  PendingCallAutoRejected = 86,
  FDLeakDetected = 87,
  RestartCamera = 88,
  AudioTestReplayFinished = 89,
  SyncDevices = 90,
  VideoCodecStateChanged = 91,
  CallFatal = 92,
  UpdateJoinableCallLog = 93,
  LobbyNacked = 94,
  PlayCallTone = 95,
  SendJoinableClientPollCriticalEvent = 96,
  SendLinkedGroupCallDowngradedCriticalEvent = 97,
  UpdateVoipSettings = 98,
  VoipErrDetectorEvent = 99,
  SpeakerStatusChanged = 100,  // Níveis de áudio (NÃO é CallEnded!)
  LonelyStateTimeout = 101,
  MutedByOthers = 102,
  LinkCreateAcked = 103,
  LinkCreateNacked = 104,
  HeartbeatNacked = 105,
  CallLinkStateChanged = 106,
  LobbyTimeout = 107,
  MuteRequestFailed = 108,
  LinkQueryNacked = 109,
  LinkJoinNacked = 110,
  CallGridRankingChanged = 111,
  GroupCallBufferHandleMessages = 112,
  RemoveUserNacked = 113,
  VideoRenderingStateChanged = 114,
  UserRemoved = 115,
  ScreenShare = 116,
  NetHealthStatusChanged = 117,
  ReminderSetAcked = 118,
  HighDataUsageDetected = 119,
  LidCallerDisplayInfo = 120,
  EagerCallDismiss = 121,
  OfferPeekTimeout = 122,
  NetHealthStatusChangedV2 = 123,
  AutoVideoPauseStateChanged = 124,
  BCallCreated = 125,
  BCallCreateFailed = 126,
  BCallAudienceUpdated = 127,
  CallSummaryReceived = 128,
  BCallJoinFailed = 129,
  BCallEndFailed = 130,
  BCallJoined = 131,
  BCallLeaveFailed = 132,
  ScreenContentType = 133,
  BCallEnded = 134,
  BCallStartNotify = 135,
  LinkEditAcked = 136,
  LinkEditNacked = 137,
  Update1to1CallLog = 138,
  CallLinkSelfStateChanged = 139,
  DataChannelReady = 140,
  AudioTxStarted = 141,
  HandleGroupCallReminder = 142,
  VoiceChatWaveReceived = 143,
  DataChannelConnectionTimeout = 144,
  ReactionStateChanged = 145,
  VideoStateChanged = 146,
  PeerVideoPermissionChanged = 147,
  RaiseHandStateChanged = 148,
  RelayListUpdate = 156,
  Max = 157,
}

/**
 * Enum de estados da chamada
 * Extraído de WAWebVoipWaCallEnums.CallState
 */
export enum CallState {
  None = 0,
  Calling = 1,
  PreacceptReceived = 2,
  ReceivedCall = 3,
  AcceptSent = 4,
  AcceptReceived = 5,
  CallActive = 6,              // ✅ Chamada conectada e ativa!
  CallActiveElseWhere = 7,
  ReceivedCallWithoutOffer = 8,
  Rejoining = 9,
  Link = 10,
  ConnectedLonely = 11,
  PreCalling = 12,
  CallStateEnding = 13,        // Chamada encerrando
  CallBCallStarting = 14,
}

/**
 * Enum de razões de término
 */
export enum CallEndReason {
  Unknown = 0,
  Normal = 1,
  Busy = 2,
  Declined = 3,
  Timeout = 4,
  Unavailable = 5,
  Cancelled = 6,
  Failed = 7,
}

/**
 * Enum de tipos de rede
 * Baseado em WAWebWamEnumCallNetworkMedium
 */
export enum NetworkMedium {
  CELLULAR = 1,
  WIFI = 2,
  NONE = 3,
}
