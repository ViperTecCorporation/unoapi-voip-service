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
      enableLogs: false,
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
          logger.debug({ session, level, message }, 'w3nder voip log')
        },
        sendDataToRelay: () => 0,
      },
    })

    logger.info({ session }, 'initializing w3nder voip wasm')
    await voip.initialize()
    logger.info({ session }, 'w3nder voip wasm initialized')
    voip.initVoipStack(selfJid, selfJid, selfLid)
    logger.info({ session }, 'waiting for voip stack ready')
    await voip.waitForVoipStackReady()

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
      if (payload.event === 'call_rejected' && typeof runtime.voip.rejectCall === 'function') {
        runtime.voip.rejectCall()
      }
      if (payload.event === 'call_ended' && typeof runtime.voip.endCall === 'function') {
        runtime.voip.endCall(0, false)
      }
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

    try {
      if (payload.msgType === 'offer') {
        runtime.voip.handleSignalingOffer({
          payload: payload.payload,
          peerJid: payload.peerJid,
          timestamp: payload.timestamp ? `${payload.timestamp}` : '0',
          isContact: true,
        })
      } else if (payload.msgType === 'ack') {
        runtime.voip.handleSignalingAck({
          payload: payload.payload,
          peerJid: payload.peerJid,
          msgType: payload.msgType,
        })
      } else if (payload.msgType === 'receipt' && typeof runtime.voip.handleSignalingReceipt === 'function') {
        runtime.voip.handleSignalingReceipt({
          payload: payload.payload,
          peerJid: payload.peerJid,
        })
      } else {
        runtime.voip.handleSignalingMessage({
          payload: payload.payload,
          peerJid: payload.peerJid,
          timestamp: payload.timestamp ? `${payload.timestamp}` : '0',
        })
      }
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
