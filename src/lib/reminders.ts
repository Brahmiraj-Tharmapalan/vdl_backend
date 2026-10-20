import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '../types/db'
import { addDays, type IsoDate } from './dates'
import { dbError } from './supabase'

type Doc = Tables<'documents'>
type Profile = Pick<Tables<'profiles'>, 'push_enabled' | 'email_enabled'>

export type ReminderChannel = 'push' | 'email'

export type ReminderRow = {
  days_before: number
  send_on: IsoDate
  channel: ReminderChannel
}

/**
 * The reminder rows a document should have. Mirrors the `rebuild_reminders` SQL function, which
 * is the source of truth (supabase/migrations/*_rebuild_reminders.sql); keep them in sync.
 *
 * One row per (reminder day × channel enabled on both profile and document), with
 * `send_on = expiry_date - days`. Rows with `send_on` before `today` are skipped. There is no
 * expiry-day (days_before = 0) row: days come only from `reminder_days` (1..365).
 */
export function buildReminderRows(
  doc: Pick<Doc, 'expiry_date' | 'reminder_days' | 'push_enabled' | 'email_enabled' | 'deleted_at'>,
  profile: Profile,
  today: IsoDate,
): ReminderRow[] {
  if (doc.deleted_at !== null) return []
  const channels: ReminderChannel[] = []
  if (profile.push_enabled && doc.push_enabled) channels.push('push')
  if (profile.email_enabled && doc.email_enabled) channels.push('email')
  const rows: ReminderRow[] = []
  for (const days of doc.reminder_days) {
    const send_on = addDays(doc.expiry_date, -days)
    if (send_on < today) continue
    for (const channel of channels) rows.push({ days_before: days, send_on, channel })
  }
  return rows
}

/**
 * Rebuilds the `scheduled` reminder rows of one or more documents (AGENTS.md rule 8) via the
 * `security definer` `rebuild_reminders` RPC, because users can only select `reminders`.
 * Several documents go in one call (one subrequest, however many).
 */
export async function rebuildReminders(
  client: SupabaseClient<Database>,
  docs: Pick<Doc, 'id'> | readonly Pick<Doc, 'id'>[],
): Promise<void> {
  const ids = (Array.isArray(docs) ? docs : [docs]).map((d: Pick<Doc, 'id'>) => d.id)
  if (ids.length === 0) return
  const { error } = await client.rpc('rebuild_reminders', { p_document_ids: ids })
  if (error) throw dbError(error)
}

/** Rebuilds reminders for all the caller's live documents (profile channel toggles changed). */
export async function rebuildAllReminders(client: SupabaseClient<Database>): Promise<void> {
  const { error } = await client.rpc('rebuild_reminders', {})
  if (error) throw dbError(error)
}

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
