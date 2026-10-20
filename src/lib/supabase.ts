import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/db'

type SupabaseEnv = Pick<
  CloudflareBindings,
  'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY'
>

// Stateless server clients: never store or refresh a session.
const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

/** Per-request client acting as the user, so RLS applies. */
export function userClient(
  env: Pick<SupabaseEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>,
  token: string,
): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth,
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

/** Bypasses RLS. Only for `cron/` and `DELETE /v1/me`. */
export function serviceClient(
  env: Pick<SupabaseEnv, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth })
}

/**
 * Wraps a Supabase/PostgREST error as a plain Error: `onError` logs it with the request ID
 * and the client only sees a generic 500.
 */
export function dbError(error: { message: string; code?: string }): Error {
  return new Error(`Supabase error${error.code ? ` ${error.code}` : ''}: ${error.message}`)
}
