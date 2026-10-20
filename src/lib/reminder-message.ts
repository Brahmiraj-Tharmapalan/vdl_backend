// Pure helpers for the reminder cron: the claim RPC row shape, message text and the per-batch
// delivery plan. The cron (src/cron/send-reminders.ts) only does I/O around these.
import { z } from 'zod'
import type { Json } from '../types/db'
import { daysBetween, formatDisplayDate, type IsoDate } from './dates'

const ts = z.string().nullable()

/** One row returned by the `claim_due_reminders` RPC (generated types lose nullability). */
const dueReminder = z.object({
  id: z.string(),
  user_id: z.string(),
  document_id: z.string(),
  days_before: z.number(),
  send_on: z.string(),
  channel: z.enum(['push', 'email']),
  doc_type: z.string(),
  custom_name: z.string().nullable(),
  expiry_date: z.string(),
  doc_push_enabled: z.boolean(),
  doc_email_enabled: z.boolean(),
  doc_deleted_at: ts,
  plate_number: z.string(),
  nickname: z.string().nullable(),
  vehicle_deleted_at: ts,
  profile_push_enabled: z.boolean(),
  profile_email_enabled: z.boolean(),
  reminder_email: z.string().nullable(),
})

export type DueReminder = z.infer<typeof dueReminder>

export function parseDueReminders(data: unknown): DueReminder[] {
  const parsed = z.array(dueReminder).safeParse(data)
  // No zod message: the log must not carry row values.
  if (!parsed.success) throw new Error('Unexpected claim_due_reminders result shape')
  return parsed.data
}

export type FinalStatus = 'sent' | 'failed' | 'skipped' | 'scheduled'
export type ReminderResult = { id: string; status: FinalStatus; error?: string }

/** `finish_reminders` payload. Errors are short codes (never tokens or emails), capped at 500. */
export function toFinishPayload(results: ReminderResult[]): Json {
  return results.map((r) =>
    r.error === undefined ? { id: r.id, status: r.status } : { ...r, error: r.error.slice(0, 500) },
  )
}

const TYPE_LABELS: Record<string, string> = {
  revenue_licence: 'Revenue licence',
  insurance: 'Insurance',
  emission_test: 'Emission test',
  registration: 'Registration',
}

export function documentLabel(type: string, customName: string | null): string {
  if (type === 'custom') return customName ?? 'Document'
  return TYPE_LABELS[type] ?? 'Document'
}

/** `expires in 5 days` / `expires in 1 day` / `expires today` / `expired`. */
export function expiryPhrase(expiry: IsoDate, today: IsoDate): string {
  const n = daysBetween(today, expiry)
  if (n < 0) return 'expired'
  if (n === 0) return 'expires today'
  return `expires in ${n} ${n === 1 ? 'day' : 'days'}`
}

/** `Insurance · CAB-1234 expires in 5 days (24 Oct 2026)` */
export function reminderMessage(
  row: Pick<DueReminder, 'doc_type' | 'custom_name' | 'plate_number' | 'expiry_date'>,
  today: IsoDate,
): string {
  const label = documentLabel(row.doc_type, row.custom_name)
  return `${label} · ${row.plate_number} ${expiryPhrase(row.expiry_date, today)} (${formatDisplayDate(row.expiry_date)})`
}

export const PUSH_TITLE = 'Vehicle Doc Lanka'

export type PushItem = { reminderId: string; userId: string; documentId: string; body: string }

export type EmailLine = { message: string; nickname: string | null }

export type EmailItem = { userId: string; to: string; reminderIds: string[]; lines: EmailLine[] }

export type DeliveryPlan = {
  /** Rows decided without sending (skipped, or failed to render). */
  results: ReminderResult[]
  /** One per push reminder; the cron fans each out to the user's devices. */
  push: PushItem[]
  /** One per user. */
  emails: EmailItem[]
}

/**
 * Decides what to do with a claimed batch at send time:
 * - doc or vehicle deleted → skipped `document_deleted`
 * - channel off on the profile or the document → skipped `push_off` / `email_off`
 * - email with no reminder_email → skipped `no_email`
 * - several due rows for one doc + channel (missed runs) → only the nearest (smallest
 *   days_before) is sent, the rest skipped `superseded`
 * A user whose rows fail to render gets `render_error` without affecting other users.
 */
export function planDelivery(rows: DueReminder[], today: IsoDate): DeliveryPlan {
  const results: ReminderResult[] = []
  const push: PushItem[] = []
  const emails: EmailItem[] = []

  const byUser = new Map<string, DueReminder[]>()
  for (const row of rows) {
    const list = byUser.get(row.user_id)
    if (list) list.push(row)
    else byUser.set(row.user_id, [row])
  }

  for (const [userId, userRows] of byUser) {
    try {
      const userResults: ReminderResult[] = []
      const userPush: PushItem[] = []
      const nearest = new Map<string, DueReminder>()

      for (const row of userRows) {
        const skip = skipReason(row)
        if (skip) {
          userResults.push({ id: row.id, status: 'skipped', error: skip })
          continue
        }
        const key = `${row.document_id}:${row.channel}`
        const kept = nearest.get(key)
        if (!kept) {
          nearest.set(key, row)
          continue
        }
        const [keep, drop] = row.days_before < kept.days_before ? [row, kept] : [kept, row]
        nearest.set(key, keep)
        userResults.push({ id: drop.id, status: 'skipped', error: 'superseded' })
      }

      const emailRows: DueReminder[] = []
      for (const row of nearest.values()) {
        if (row.channel === 'push') {
          userPush.push({
            reminderId: row.id,
            userId,
            documentId: row.document_id,
            body: reminderMessage(row, today),
          })
        } else {
          emailRows.push(row)
        }
      }

      let email: EmailItem | undefined
      const to = emailRows[0]?.reminder_email
      if (emailRows.length > 0 && to) {
        emailRows.sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : 0))
        email = {
          userId,
          to,
          reminderIds: emailRows.map((r) => r.id),
          lines: emailRows.map((r) => ({ message: reminderMessage(r, today), nickname: r.nickname })),
        }
      }

      results.push(...userResults)
      push.push(...userPush)
      if (email) emails.push(email)
    } catch {
      for (const row of userRows) results.push({ id: row.id, status: 'failed', error: 'render_error' })
    }
  }

  return { results, push, emails }
}

function skipReason(row: DueReminder): string | null {
  if (row.doc_deleted_at !== null || row.vehicle_deleted_at !== null) return 'document_deleted'
  if (row.channel === 'push') {
    return row.profile_push_enabled && row.doc_push_enabled ? null : 'push_off'
  }
  if (!(row.profile_email_enabled && row.doc_email_enabled)) return 'email_off'
  return row.reminder_email ? null : 'no_email'
}
