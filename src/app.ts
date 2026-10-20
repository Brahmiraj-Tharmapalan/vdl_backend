import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { except } from 'hono/combine'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { timeout } from 'hono/timeout'
import type { AppEnv } from './env'
import { errorBody, toErrorResponse } from './lib/errors'
import { auth } from './middleware/auth'
import { logger } from './middleware/logger'
import { rateLimit, writeRateLimit } from './middleware/rate-limit'
import dashboard from './routes/dashboard'
import devices from './routes/devices'
import documents from './routes/documents'
import me from './routes/me'
import reminders from './routes/reminders'
import sync from './routes/sync'
import vehicles from './routes/vehicles'

const KB = 1024
const PUBLIC_PATHS = ['/v1/health']

const app = new Hono<AppEnv>()

// Always server-generated: a client-sent X-Request-Id would let callers forge log entries' ids.
app.use(requestId({ headerName: '' }))
app.use(logger)
app.use(secureHeaders())
// Responses carry personal data (plates, email): never let a cache or proxy keep them.
app.use(async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
  c.header('X-Request-Id', c.var.requestId)
})
app.use('/v1/sync', bodyLimit({ maxSize: 1024 * KB }))
app.use(except('/v1/sync', bodyLimit({ maxSize: 100 * KB })))
app.use(timeout(10_000))
// Everything except /health needs auth, including unknown paths (no route probing).
app.use(except(PUBLIC_PATHS, auth()))
app.use(except(PUBLIC_PATHS, rateLimit))
app.use(except(PUBLIC_PATHS, writeRateLimit))

app.get('/v1/health', (c) => c.json({ status: 'ok' }))
app.route('/v1/me', me)
app.route('/v1/devices', devices)
app.route('/v1/vehicles', vehicles)
app.route('/v1/documents', documents)
app.route('/v1/dashboard', dashboard)
app.route('/v1/reminders', reminders)
app.route('/v1/sync', sync)

app.onError((err, c) => {
  const requestId = c.var.requestId ?? 'unknown'
  const { status, body } = toErrorResponse(err, requestId)
  if (status >= 500) {
    console.error(
      JSON.stringify({
        level: 'error',
        requestId,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : String(err),
      }),
    )
  }
  return c.json(body, status)
})

app.notFound((c) => c.json(errorBody('not_found', 'Not found', c.var.requestId ?? 'unknown'), 404))

export default app
