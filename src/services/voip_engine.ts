import logger from './logger'
import { CallEventPayload, CallSessionState, SignalingPayload, VoipCommand } from '../types/contracts'
import { w3nderVoipAdapter } from './w3nder_adapter'

export class VoipEngine {
  private calls = new Map<string, CallSessionState>()
  private pipelines = new Map<string, Promise<unknown>>()

  private getKey(session: string, callId: string) {
    return `${session}:${callId}`
  }

  private async serializeByCall<T>(session: string, callId: string, task: () => Promise<T>): Promise<T> {
    const key = this.getKey(session, callId)
    const previous = this.pipelines.get(key) || Promise.resolve()
    let current: Promise<T>
    current = previous.catch(() => undefined).then(task)
    this.pipelines.set(key, current as Promise<unknown>)
    try {
      return await current
    } finally {
      if (this.pipelines.get(key) === current) this.pipelines.delete(key)
    }
  }

  getCall(session: string, callId: string): CallSessionState | undefined {
    return this.calls.get(this.getKey(session, callId))
  }

  async handleCallEvent(payload: CallEventPayload): Promise<{ state: CallSessionState; commands: VoipCommand[] }> {
    return this.serializeByCall(payload.session, payload.callId, async () => {
      const key = this.getKey(payload.session, payload.callId)
      const state: CallSessionState = {
        session: payload.session,
        callId: payload.callId,
        from: payload.from,
        callerPn: payload.callerPn,
        isVideo: payload.isVideo,
        lastEvent: payload.event,
        updatedAt: Date.now(),
      }
      this.calls.set(key, state)

      logger.info({ session: payload.session, callId: payload.callId, event: payload.event, from: payload.from }, 'voip event received')

      const commands = await w3nderVoipAdapter.handleCallEvent(payload)

      return {
        state,
        commands,
      }
    })
  }

  async handleSignaling(payload: SignalingPayload): Promise<{ state?: CallSessionState; commands: VoipCommand[] }> {
    return this.serializeByCall(payload.session, payload.callId, async () => {
      const state = this.getCall(payload.session, payload.callId)

      logger.info(
        { session: payload.session, callId: payload.callId, peerJid: payload.peerJid, msgType: payload.msgType || 'unknown' },
        'signaling received'
      )

      const commands = await w3nderVoipAdapter.handleSignaling(payload)

      return {
        state,
        commands,
      }
    })
  }
}

export const voipEngine = new VoipEngine()
