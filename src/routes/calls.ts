import { Router } from 'express'
import { callEventPayloadSchema, signalingPayloadSchema } from '../types/contracts'
import { voipEngine } from '../services/voip_engine'

const router = Router()

router.post('/events', async (req, res) => {
  const parsed = callEventPayloadSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_call_event_payload',
      details: parsed.error.flatten(),
    })
  }

  const result = await voipEngine.handleCallEvent(parsed.data)
  return res.json(result)
})

router.post('/signaling', async (req, res) => {
  const parsed = signalingPayloadSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_signaling_payload',
      details: parsed.error.flatten(),
    })
  }

  const result = await voipEngine.handleSignaling(parsed.data)
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
