import type { SupabaseClient } from '@supabase/supabase-js'

export type AuthUser = {
  id: string
  email: string | undefined
  sessionId: string | undefined
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: {
    user: AuthUser
    supabase: SupabaseClient
    requestId: string
  }
}
