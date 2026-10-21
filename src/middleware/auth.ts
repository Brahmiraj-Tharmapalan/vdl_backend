import { createMiddleware } from 'hono/factory'
import { jwk } from 'hono/jwk'
import { z } from 'zod'
import type { AppEnv } from '../env'
import { unauthorized } from '../lib/errors'
import { getJwks, tokenKid } from '../lib/jwks'
import { userClient } from '../lib/supabase'

// iss/aud/exp/nbf values and the signature are checked by `jwk`; this adds what it can't.
const claimsSchema = z.object({
  sub: z.string().min(1),
  role: z.literal('authenticated'),
  // `jwk` only checks exp when present, so require it here.
  exp: z.number(),
  // Anonymous Supabase users also get role `authenticated`. They would allow unlimited accounts
  // without Google sign-in (sidestepping the per-user limits and quotas), so reject them.
  is_anonymous: z.literal(false).optional(),
  email: z.string().optional(),
  session_id: z.string().optional(),
  // Supabase's sign-in methods with their times. Unlike iat, these survive token refreshes.
  amr: z.array(z.object({ method: z.string(), timestamp: z.number() })).optional(),
})

const bearerToken = (header: string | undefined) => header?.split(/\s+/)[1]

/**
 * Verifies the Supabase access token (Authorization: Bearer only) and sets
 * `c.var.user` and the per-request `c.var.supabase` client. Any failure is a 401.
 */
export const auth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    // `keys` instead of `jwks_uri`: jwk would fetch the JWKS on every request.
    const verify = jwk({
      keys: () => getJwks(c.env.SUPABASE_JWKS_URL, tokenKid(bearerToken(c.req.header('Authorization')))),
      alg: ['ES256', 'RS256'],
      verification: { iss: c.env.SUPABASE_JWT_ISSUER, aud: 'authenticated' },
    })

    await verify(c, async () => {
      const claims = claimsSchema.safeParse(c.var.jwtPayload)
      if (!claims.success) throw unauthorized()

      // jwk accepted the header, so it is exactly "Bearer <token>".
      const token = bearerToken(c.req.header('Authorization'))
      if (!token) throw unauthorized()

      c.set('user', {
        id: claims.data.sub,
        email: claims.data.email,
        sessionId: claims.data.session_id,
        signedInAt: claims.data.amr?.length
          ? Math.max(...claims.data.amr.map((a) => a.timestamp))
          : undefined,
      })
      c.set('supabase', userClient(c.env, token))
      await next()
    })
  })
