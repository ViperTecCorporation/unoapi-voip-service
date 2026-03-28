import logger from './logger'
import { CallEventPayload, SignalingPayload, VoipCommand } from '../types/contracts'
import { WhatsAppVoipWasm } from '../vendor/w3nder-whatsapp-voip-wasm/lib/WhatsAppVoipWasm'

interface SessionRuntime {
  session: string
  selfJid: string
  selfLid: string
  voip: WhatsAppVoipWasm
  pendingCommands: VoipCommand[]
}

export class W3nderVoipAdapter {
  private sessions = new Map<string, SessionRuntime>()
  private sessionInitializations = new Map<string, Promise<SessionRuntime>>()

  private decodeIncomingSignalingPayload(payload: SignalingPayload): string {
    if (payload.payloadBase64) {
      if ((payload.payloadEncoding || 'wa_binary') === 'wa_binary') {
        return payload.payloadBase64
      }
      const decoded = Buffer.from(payload.payloadBase64, 'base64')
      return decoded.toString('utf8')
    }
    return payload.payload || ''
  }

  private getAttr(payload: SignalingPayload, ...keys: string[]): string {
    for (const key of keys) {
      const value = payload.attrs?.[key] ?? payload.outerAttrs?.[key] ?? payload.encAttrs?.[key]
      if (value !== undefined && value !== null && `${value}`.trim()) return `${value}`.trim()
    }
    return ''
  }

  private getNumericAttr(payload: SignalingPayload, ...keys: string[]): number | undefined {
    const value = this.getAttr(payload, ...keys)
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  private getPeerPlatform(payload: SignalingPayload): number | undefined {
    const raw = this.getAttr(payload, 'platform', 'peer_platform', 'peerPlatform')
    if (!raw) return undefined
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
    const normalized = raw.trim().toLowerCase()
    if (['iphone', 'ios', 'ipad'].includes(normalized)) return 2
    if (['android'].includes(normalized)) return 1
    return undefined
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  private buildSelfJids(session: string) {
    const digits = `${session || ''}`.replace(/\D/g, '')
    return {
      selfJid: `${digits}@s.whatsapp.net`,
      selfLid: `${digits}@lid`,
    }
  }

  private drainCommands(runtime?: SessionRuntime): VoipCommand[] {
    if (!runtime) return []
    const out = [...runtime.pendingCommands]
    runtime.pendingCommands.length = 0
    return out
  }

  async ensureSession(session: string): Promise<{ runtime?: SessionRuntime; commands: VoipCommand[] }> {
    const existing = this.sessions.get(session)
    if (existing) {
      logger.debug({ session, pendingCommands: existing.pendingCommands.length }, 'reusing existing voip session runtime')
      return { runtime: existing, commands: this.drainCommands(existing) }
    }
    const pending = this.sessionInitializations.get(session)
    if (pending) {
      logger.info({ session }, 'awaiting in-flight voip session initialization')
      const runtime = await pending
      return { runtime, commands: this.drainCommands(runtime) }
    }

    const initialization = (async (): Promise<SessionRuntime> => {
    const { selfJid, selfLid } = this.buildSelfJids(session)
    const pendingCommands: VoipCommand[] = []
    const startedAt = Date.now()

    logger.info({ session, selfJid, selfLid }, 'creating voip session runtime')
    const voip = new WhatsAppVoipWasm({
      enableLogs: true,
      callbacks: {
        onSignalingXmpp: async (peerJid: string, callId: string, xmlPayload: Uint8Array) => {
          pendingCommands.push({
            action: 'send_call_node',
            session,
            callId,
            peerJid,
            payloadBase64: Buffer.from(xmlPayload).toString('base64'),
            payloadTag: 'call',
          })
          logger.info(
            {
              session,
              callId,
              peerJid,
              payloadBytes: xmlPayload.byteLength,
              pendingCommands: pendingCommands.length,
            },
            'queued send_call_node command from wasm'
          )
        },
        onCallEvent: (eventType: number, eventData?: string) => {
          logger.info(
            {
              session,
              eventType,
              hasEventData: !!eventData,
              eventDataPreview: eventData ? `${eventData}`.slice(0, 500) : undefined,
            },
            'received voip event callback from wasm'
          )
          pendingCommands.push({
            action: 'voip_event',
            session,
            callId: this.extractCallId(eventData),
            eventType,
            eventData,
          })
          logger.info(
            {
              session,
              eventType,
              pendingCommands: pendingCommands.length,
            },
            'queued voip event command from wasm'
          )
        },
        onVoipReady: () => {
          logger.info({ session }, 'w3nder voip stack ready')
        },
        onLog: (level: string, message: string) => {
          logger.info({ session, level, message }, 'w3nder voip log')
        },
        sendDataToRelay: (data: Uint8Array, ip: string, port: number) => {
          logger.info(
            {
              session,
              ip,
              port,
              bytes: data?.byteLength || 0,
            },
            'wasm requested relay send'
          )
          return 0
        },
      },
    })

    logger.info({ session }, 'initializing w3nder voip wasm')
    await voip.initialize()
    logger.info({ session }, 'w3nder voip wasm initialized')
    try {
      const available = voip.getAvailableFunctions()
      logger.info(
        {
          session,
          functionCount: available.length,
          functionsPreview: available.slice(0, 40),
        },
        'w3nder voip exported functions'
      )
    } catch (error) {
      logger.warn({ err: error, session }, 'failed to inspect w3nder exported functions')
    }
    voip.initVoipStack(selfJid, selfJid, selfLid)
    logger.info({ session }, 'waiting for voip stack ready')
    await voip.waitForVoipStackReady()
    try {
      logger.info(
        {
          session,
          isReady: voip.isVoipStackReady(),
          callInfo: voip.getCallInfo(),
        },
        'voip stack ready state after wait'
      )
    } catch (error) {
      logger.warn({ err: error, session }, 'failed to read call info after voip init')
    }

    const runtime: SessionRuntime = {
      session,
      selfJid,
      selfLid,
      voip,
      pendingCommands,
    }
    this.sessions.set(session, runtime)
    logger.info(
      {
        session,
        durationMs: Date.now() - startedAt,
        pendingCommands: pendingCommands.length,
      },
      'voip session runtime created'
    )
      return runtime
    })()

    this.sessionInitializations.set(session, initialization)
    try {
      const runtime = await initialization
      return { runtime, commands: this.drainCommands(runtime) }
    } finally {
      this.sessionInitializations.delete(session)
    }
  }

  private extractCallId(eventData?: string): string {
    if (!eventData) return 'unknown'
    try {
      const parsed = JSON.parse(eventData)
      return `${parsed?.callId || parsed?.call_id || 'unknown'}`
    } catch {
      return 'unknown'
    }
  }

  async handleCallEvent(payload: CallEventPayload): Promise<VoipCommand[]> {
    const startedAt = Date.now()
    const { runtime, commands } = await this.ensureSession(payload.session)
    if (!runtime) return commands

    try {
      logger.info(
        {
          session: payload.session,
          callId: payload.callId,
          event: payload.event,
          callInfoBefore: runtime.voip.getCallInfo(),
        },
        'processing call event in w3nder adapter'
      )
      if (payload.event === 'call_rejected' && typeof runtime.voip.rejectCall === 'function') {
        runtime.voip.rejectCall()
      }
      if (payload.event === 'call_ended' && typeof runtime.voip.endCall === 'function') {
        runtime.voip.endCall(0, false)
      }
      logger.info(
        {
          session: payload.session,
          callId: payload.callId,
          event: payload.event,
          callInfoAfter: runtime.voip.getCallInfo(),
        },
        'processed call event state in w3nder adapter'
      )
    } catch (error) {
      logger.warn(error, 'failed to process call event in w3nder adapter')
    }

    const out = [...commands, ...this.drainCommands(runtime)]
    logger.info(
      {
        session: payload.session,
        callId: payload.callId,
        event: payload.event,
        commandCount: out.length,
        durationMs: Date.now() - startedAt,
      },
      'processed call event in w3nder adapter'
    )
    return out
  }

  async handleSignaling(payload: SignalingPayload): Promise<VoipCommand[]> {
    const startedAt = Date.now()
    const { runtime, commands } = await this.ensureSession(payload.session)
    if (!runtime) return commands
    const decodedPayload = this.decodeIncomingSignalingPayload(payload)

    try {
      logger.info(
        {
          session: payload.session,
          callId: payload.callId,
          peerJid: payload.peerJid,
          msgType: payload.msgType || 'unknown',
          payloadEncoding: payload.payloadEncoding || (payload.payloadBase64 ? 'wa_binary' : 'xml'),
          payloadBytes: payload.payloadBase64 ? Buffer.from(payload.payloadBase64, 'base64').byteLength : undefined,
          attrs: payload.attrs,
          outerAttrs: payload.outerAttrs,
          encAttrs: payload.encAttrs,
          callInfoBefore: runtime.voip.getCallInfo(),
          payloadPreview: payload.payload ? payload.payload.slice(0, 500) : undefined,
        },
        'processing signaling in w3nder adapter'
      )
      if (payload.msgType === 'offer') {
        runtime.voip.handleSignalingOffer({
          payload: decodedPayload,
          peerJid: payload.peerJid,
          isContact: true,
        })
      } else if (payload.msgType === 'ack') {
        runtime.voip.handleSignalingAck({
          payload: decodedPayload,
          peerJid: payload.peerJid,
          msgType: payload.msgType,
        })
      } else if (payload.msgType === 'receipt' && typeof runtime.voip.handleSignalingReceipt === 'function') {
        runtime.voip.handleSignalingReceipt({
          payload: decodedPayload,
          peerJid: payload.peerJid,
        })
      } else {
        const epochId = this.getAttr(payload, 'e', 'epoch-id', 'epochId') || undefined
        const peerPlatform = this.getPeerPlatform(payload)
        const peerAppVersion = this.getAttr(payload, 'version', 'peer_app_version', 'peerAppVersion') || undefined
        runtime.voip.handleSignalingMessage({
          payload: decodedPayload,
          peerJid: payload.peerJid,
          peerPlatform,
          peerAppVersion,
          epochId,
          timestamp: payload.timestamp ? `${payload.timestamp}` : '0',
        })
      }
      logger.info(
        {
          session: payload.session,
          callId: payload.callId,
          peerJid: payload.peerJid,
          msgType: payload.msgType || 'unknown',
          callInfoAfter: runtime.voip.getCallInfo(),
        },
        'processed signaling state in w3nder adapter'
      )
    } catch (error) {
      logger.warn(error, 'failed to process signaling in w3nder adapter')
    }

    const out = [...commands, ...this.drainCommands(runtime)]
    logger.info(
      {
        session: payload.session,
        callId: payload.callId,
        peerJid: payload.peerJid,
        msgType: payload.msgType || 'unknown',
        commandCount: out.length,
        durationMs: Date.now() - startedAt,
      },
      'processed signaling in w3nder adapter'
    )
    return out
  }
}

export const w3nderVoipAdapter = new W3nderVoipAdapter()
