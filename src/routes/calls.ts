import { Router } from 'express'
import { callEventPayloadSchema, signalingPayloadSchema } from '../types/contracts'
import { voipEngine } from '../services/voip_engine'
import logger from '../services/logger'

const router = Router()

router.post('/events', async (req, res) => {
  const startedAt = Date.now()
  const parsed = callEventPayloadSchema.safeParse(req.body)
  if (!parsed.success) {
    logger.warn({ body: req.body, details: parsed.error.flatten() }, 'invalid call event payload')
    return res.status(400).json({
      error: 'invalid_call_event_payload',
      details: parsed.error.flatten(),
    })
  }

  logger.info(
    {
      session: parsed.data.session,
      callId: parsed.data.callId,
      event: parsed.data.event,
      from: parsed.data.from,
    },
    'call event request started'
  )

  const result = await voipEngine.handleCallEvent(parsed.data)
  logger.info(
    {
      session: parsed.data.session,
      callId: parsed.data.callId,
      event: parsed.data.event,
      commandCount: result.commands.length,
      durationMs: Date.now() - startedAt,
    },
    'call event request completed'
  )
  return res.json(result)
})

router.post('/signaling', async (req, res) => {
  const startedAt = Date.now()
  const parsed = signalingPayloadSchema.safeParse(req.body)
  if (!parsed.success) {
    logger.warn({ body: req.body, details: parsed.error.flatten() }, 'invalid signaling payload')
    return res.status(400).json({
      error: 'invalid_signaling_payload',
      details: parsed.error.flatten(),
    })
  }

  logger.info(
    {
      session: parsed.data.session,
      callId: parsed.data.callId,
      peerJid: parsed.data.peerJid,
      msgType: parsed.data.msgType || 'unknown',
      payloadLength: parsed.data.payload?.length || 0,
    },
    'signaling request started'
  )

  const result = await voipEngine.handleSignaling(parsed.data)
  logger.info(
    {
      session: parsed.data.session,
      callId: parsed.data.callId,
      peerJid: parsed.data.peerJid,
      msgType: parsed.data.msgType || 'unknown',
      commandCount: result.commands.length,
      durationMs: Date.now() - startedAt,
    },
    'signaling request completed'
  )
  return res.json(result)
})

router.get('/sessions/:session/calls/:callId', (req, res) => {
  const state = voipEngine.getCall(req.params.session, req.params.callId)
  if (!state) {
    return res.status(404).json({ error: 'call_not_found' })
  }
  return res.json({ state })
})

export default router
