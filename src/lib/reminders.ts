import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '../types/db'

type Doc = Tables<'documents'>

/**
 * Rebuilds a document's `scheduled` reminder rows (AGENTS.md rule 8).
 *
 * STUB until P6: does nothing. P6 replaces the body with a call to a `security definer`
 * `rebuild_reminders` RPC, because users can only select `reminders`. Routes already call it
 * on create, delete and any change that `remindersChanged()` reports.
 */
export async function rebuildReminders(
  _client: SupabaseClient<Database>,
  _doc: Doc,
): Promise<void> {}

const sameDays = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((d, i) => d === b[i])

/** True when a field that drives reminders differs (expiry, days, channel toggles). */
export function remindersChanged(before: Doc, after: Doc): boolean {
  return (
    before.expiry_date !== after.expiry_date ||
    !sameDays(before.reminder_days, after.reminder_days) ||
    before.push_enabled !== after.push_enabled ||
    before.email_enabled !== after.email_enabled ||
    before.deleted_at !== after.deleted_at
  )
}
