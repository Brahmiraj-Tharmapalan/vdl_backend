import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './types/db'

export type AuthUser = {
  id: string
  email: string | undefined
  sessionId: string | undefined
}

export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: {
    user: AuthUser
    supabase: SupabaseClient<Database>
    requestId: string
  }
}
