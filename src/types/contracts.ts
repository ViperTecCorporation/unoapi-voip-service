import { z } from 'zod'

export const callEventPayloadSchema = z.object({
  session: z.string().min(1),
  event: z.enum([
    'incoming_call',
    'call_ringing',
    'call_accepted',
    'call_rejected',
    'call_ended',
    'call_timeout',
    'call_error',
  ]),
  callId: z.string().min(1),
  from: z.string().min(1),
  callerPn: z.string().optional(),
  isGroup: z.boolean().optional(),
  groupJid: z.string().optional(),
  isVideo: z.boolean().optional(),
  timestamp: z.number().int().optional(),
  raw: z.unknown().optional(),
})

export const signalingPayloadSchema = z.object({
  session: z.string().min(1),
  callId: z.string().min(1),
  peerJid: z.string().min(1),
  payload: z.string().optional(),
  payloadBase64: z.string().optional(),
  rawDecryptedCallFrameBase64: z.string().optional(),
  rawOfferWapNoPrefixBase64: z.string().optional(),
  rawOfferChildWapBase64: z.string().optional(),
  payloadEncoding: z.enum(['xml', 'wa_binary']).optional(),
  attrs: z.record(z.string()).optional(),
  outerAttrs: z.record(z.string()).optional(),
  encAttrs: z.record(z.string()).optional(),
  msgType: z.string().optional(),
  timestamp: z.number().int().optional(),
}).refine((value) => !!value.payload || !!value.payloadBase64, {
  message: 'payload or payloadBase64 is required',
})

export type CallEventPayload = z.infer<typeof callEventPayloadSchema>
export type SignalingPayload = z.infer<typeof signalingPayloadSchema>

export type VoipCommand =
  | {
      action: 'send_call_node'
      session: string
      callId: string
      peerJid: string
      payloadBase64: string
      payloadTag?: string
    }
  | {
      action: 'voip_event'
      session: string
      callId: string
      eventType: number
      eventData?: string
    }
  | {
      action: 'noop'
      session: string
      callId: string
      reason: string
    }

export interface CallSessionState {
  session: string
  callId: string
  from: string
  callerPn?: string
  isGroup?: boolean
  groupJid?: string
  isVideo?: boolean
  lastEvent: string
  updatedAt: number
}
