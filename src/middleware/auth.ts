import { createMiddleware } from 'hono/factory'
import { jwk } from 'hono/jwk'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { unauthorized } from '../lib/errors'
import { userClient } from '../lib/supabase'

// iss/aud/exp/nbf values and the signature are checked by `jwk`; this adds what it can't.
const claimsSchema = z.object({
  sub: z.string().min(1),
  role: z.literal('authenticated'),
  // `jwk` only checks exp when present, so require it here.
  exp: z.number(),
  email: z.string().optional(),
  session_id: z.string().optional(),
})

/**
 * Verifies the Supabase access token (Authorization: Bearer only) and sets
 * `c.var.user` and the per-request `c.var.supabase` client. Any failure is a 401.
 */
export const auth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const verify = jwk(
      {
        jwks_uri: c.env.SUPABASE_JWKS_URL,
        alg: ['ES256', 'RS256'],
        verification: { iss: c.env.SUPABASE_JWT_ISSUER, aud: 'authenticated' },
      },
      // Cache the JWKS at the edge; jwk fetches it on every request otherwise.
      { cf: { cacheTtl: 600, cacheEverything: true } },
    )

    await verify(c, async () => {
      const claims = claimsSchema.safeParse(c.var.jwtPayload)
      if (!claims.success) throw unauthorized()

      // jwk accepted the header, so it is exactly "Bearer <token>".
      const token = c.req.header('Authorization')?.split(/\s+/)[1]
      if (!token) throw unauthorized()

      c.set('user', {
        id: claims.data.sub,
        email: claims.data.email,
        sessionId: claims.data.session_id,
      })
      c.set('supabase', userClient(c.env, token))
      await next()
    })
  })
