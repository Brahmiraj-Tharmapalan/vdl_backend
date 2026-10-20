import type { SupabaseClient } from '@supabase/supabase-js'
import type { JWTPayload } from 'hono/utils/jwt/types'
import type { Database } from './types/db'

export type AuthUser = {
  id: string
  email: string | undefined
  sessionId: string | undefined
  /** Unix seconds of the latest real sign-in (JWT `amr`), not of the last token refresh. */
  signedInAt: number | undefined
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: {
    user: AuthUser
    supabase: SupabaseClient<Database>
    requestId: string
    /** Set by Hono's jwk middleware; read only by middleware/auth.ts */
    jwtPayload: JWTPayload
  }
}
