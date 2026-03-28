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
    if (existing) return { runtime: existing, commands: this.drainCommands(existing) }

    const { selfJid, selfLid } = this.buildSelfJids(session)
    const pendingCommands: VoipCommand[] = []
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
        },
        onCallEvent: (eventType: number, eventData?: string) => {
          pendingCommands.push({
            action: 'voip_event',
            session,
            callId: this.extractCallId(eventData),
            eventType,
            eventData,
          })
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

    await voip.initialize()
    voip.initVoipStack(selfJid, selfJid, selfLid)
    await voip.waitForVoipStackReady()

    const runtime: SessionRuntime = {
      session,
      selfJid,
      selfLid,
      voip,
      pendingCommands,
    }
    this.sessions.set(session, runtime)
    return { runtime, commands: this.drainCommands(runtime) }
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

    return [...commands, ...this.drainCommands(runtime)]
  }

  async handleSignaling(payload: SignalingPayload): Promise<VoipCommand[]> {
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

    return [...commands, ...this.drainCommands(runtime)]
  }
}

export const w3nderVoipAdapter = new W3nderVoipAdapter()
