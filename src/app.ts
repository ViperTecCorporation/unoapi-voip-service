import express from 'express'
import callsRouter from './routes/calls'
import logger from './services/logger'
import { appConfig } from './config'

const app = express()

app.use(express.json({ limit: '2mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'unoapi-voip-service' })
})

app.use((req, res, next) => {
  if (!appConfig.voipServiceToken) return next()

  const header = `${req.headers.authorization || ''}`.trim()
  const expected = `Bearer ${appConfig.voipServiceToken}`
  if (header === expected) return next()

  return res.status(401).json({ error: 'unauthorized' })
})

app.use('/v1/calls', callsRouter)

app.listen(appConfig.port, () => {
  logger.info({ port: appConfig.port, tokenConfigured: !!appConfig.voipServiceToken }, 'unoapi-voip-service listening')
})
