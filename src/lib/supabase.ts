import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/db'
import { limitReached } from './errors'

type SupabaseEnv = Pick<
  CloudflareBindings,
  'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY' | 'GATEWAY_KEY'
>

// Stateless server clients: never store or refresh a session.
const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

/** Header the DB's PostgREST pre-request check requires (migrations/*_data_api_gateway.sql). */
export const GATEWAY_HEADER = 'x-vdl-gateway'

/**
 * Per-request client acting as the user, so RLS applies. The gateway header lets it through the
 * Data API, which rejects the same user JWT sent directly from outside the Worker.
 */
export function userClient(
  env: Pick<SupabaseEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'GATEWAY_KEY'>,
  token: string,
): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth,
    global: { headers: { Authorization: `Bearer ${token}`, [GATEWAY_HEADER]: env.GATEWAY_KEY } },
  })
}

/** Bypasses RLS. Only for `cron/` and `DELETE /v1/me`. */
export function serviceClient(
  env: Pick<SupabaseEnv, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth })
}

/** SQLSTATE raised by the per-user quota triggers (supabase/migrations/*_harden_limits.sql). */
export const QUOTA_SQLSTATE = 'VDL01'

/**
 * Wraps a Supabase/PostgREST error as a plain Error: `onError` logs it with the request ID
 * and the client only sees a generic 500. A quota error becomes a 409 `limit_reached`.
 */
export function dbError(error: { message: string; code?: string }): Error {
  if (error.code === QUOTA_SQLSTATE) return limitReached()
  return new Error(`Supabase error${error.code ? ` ${error.code}` : ''}: ${error.message}`)
}
