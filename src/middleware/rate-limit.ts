import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../env'
import { rateLimited } from '../lib/errors'

type LimiterName = 'RATE_LIMITER' | 'STRICT_RATE_LIMITER'

/** Limits per user (not IP). Must run after `auth`. */
const limitBy = (binding: LimiterName) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { success } = await c.env[binding].limit({ key: c.var.user.id })
    if (!success) throw rateLimited()
    await next()
  })

/** 100/min, all authed routes. */
export const rateLimit = limitBy('RATE_LIMITER')

/** 10/min, for /v1/sync, POST /v1/devices and DELETE /v1/me. */
export const strictRateLimit = limitBy('STRICT_RATE_LIMITER')
