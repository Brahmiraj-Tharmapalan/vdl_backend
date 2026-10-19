import { createMiddleware } from 'hono/factory'
import { routePath } from 'hono/route'
import type { AppEnv } from '../env'

/**
 * One JSON line per request. Logs the route pattern (not the URL) and nothing from
 * headers, query or body, so no tokens or user data end up in logs.
 */
export const logger = createMiddleware<AppEnv>(async (c, next) => {
  const start = Date.now()
  await next()
  const status = c.res.status
  console.log(
    JSON.stringify({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      requestId: c.var.requestId,
      method: c.req.method,
      route: routePath(c, -1),
      status,
      durationMs: Date.now() - start,
    }),
  )
})
