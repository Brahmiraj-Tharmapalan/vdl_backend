// Daily reminder delivery (cron `0 2 * * *` = 07:30 Asia/Colombo). Uses the service-role client
// (AGENTS.md rule 7). At-most-once: rows are claimed (scheduled → sending) before any send, and
// every claimed row gets a final status via finish_reminders, so a re-run never resends.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/db'
import { todayInColombo, type IsoDate } from '../lib/dates'
import {
  RESEND_BATCH_SIZE,
  renderReminderEmail,
  sendEmail,
  sendEmailBatch,
  shouldRetryIndividually,
  type Email,
} from '../lib/email'
import { EXPO_CHUNK_SIZE, chunk, sendPushChunk, type PushMessage, type PushOutcome } from '../lib/push'
import {
  PUSH_TITLE,
  parseDueReminders,
  planDelivery,
  toFinishPayload,
  type DueReminder,
  type ReminderResult,
} from '../lib/reminder-message'
import { serviceClient } from '../lib/supabase'

/** Workers Free allows 50 subrequests per cron run; keep a margin. Raise on the Paid plan. */
export const SUBREQUEST_BUDGET = 45
/** Rows per claim (whole users, so a batch can be slightly larger). */
export const BATCH_SIZE = 100
/** claim + devices + push + email + finish */
const MIN_BATCH_COST = 5

type CronEnv = Pick<
  CloudflareBindings,
  'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'EXPO_ACCESS_TOKEN' | 'RESEND_API_KEY' | 'EMAIL_FROM'
>

type Db = SupabaseClient<Database>

export type RunSummary = {
  today: IsoDate
  batches: number
  claimed: number
  sent: number
  failed: number
  skipped: number
  released: number
  deadTokens: number
  subrequests: number
}

/** Counts subrequests (fetches) against a fixed limit. */
class Budget {
  used = 0
  constructor(readonly limit: number) {}
  get left() {
    return this.limit - this.used
  }
  take(): boolean {
    if (this.used >= this.limit) return false
    this.used++
    return true
  }
}

const EVENT = 'cron.send_reminders'

/** Logs only codes and counts: never tokens, emails, plates or Supabase messages. */
function logError(stage: string, code?: string) {
  console.error(JSON.stringify({ level: 'error', event: EVENT, stage, code: code ?? null }))
}

export async function sendReminders(env: CronEnv, scheduledTime: number): Promise<RunSummary> {
  const start = Date.now()
  const today = todayInColombo(new Date(scheduledTime))
  const summary: RunSummary = {
    today,
    batches: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    released: 0,
    deadTokens: 0,
    subrequests: 0,
  }
  const budget = new Budget(SUBREQUEST_BUDGET)

  try {
    const db = serviceClient(env)
    while (budget.left >= MIN_BATCH_COST) {
      budget.take()
      const { data, error } = await db.rpc('claim_due_reminders', {
        p_today: today,
        p_limit: BATCH_SIZE,
      })
      if (error) {
        logError('claim', error.code)
        break
      }
      const rows = parseDueReminders(data)
      if (rows.length === 0) break
      summary.batches++
      summary.claimed += rows.length

      // Keep one subrequest for finish_reminders.
      const deliver = new Budget(budget.left - 1)
      const results = await deliverBatch(db, env, rows, today, deliver, summary)
      budget.used += deliver.used

      budget.take()
      const { error: finishError } = await db.rpc('finish_reminders', {
        p_results: toFinishPayload(results),
      })
      if (finishError) {
        // The rows stay `sending` and are failed as `interrupted` by a later run.
        logError('finish', finishError.code)
        break
      }
      for (const r of results) {
        if (r.status === 'scheduled') summary.released++
        else summary[r.status]++
      }
      // Rows were released because the budget ran out: stop, the next run picks them up.
      if (results.some((r) => r.status === 'scheduled')) break
    }
  } catch (err) {
    logError('run', err instanceof Error ? err.name : undefined)
  }

  summary.subrequests = budget.used
  console.log(
    JSON.stringify({ level: 'info', event: EVENT, ...summary, durationMs: Date.now() - start }),
  )
  return summary
}

/** Sends one claimed batch. Returns a result for every row. */
async function deliverBatch(
  db: Db,
  env: CronEnv,
  rows: DueReminder[],
  today: IsoDate,
  budget: Budget,
  summary: RunSummary,
): Promise<ReminderResult[]> {
  const plan = planDelivery(rows, today)
  const results = [...plan.results]

  try {
    results.push(...(await deliverPush(db, env, plan.push, budget, summary)))
  } catch {
    logError('push')
  }
  try {
    results.push(...(await deliverEmail(env, plan.emails, budget)))
  } catch {
    logError('email')
  }

  // Anything without an outcome (an unexpected error above) failed; never retried.
  const done = new Set(results.map((r) => r.id))
  for (const row of rows) {
    if (!done.has(row.id)) results.push({ id: row.id, status: 'failed', error: 'internal_error' })
  }
  return results
}

async function deliverPush(
  db: Db,
  env: CronEnv,
  items: ReturnType<typeof planDelivery>['push'],
  budget: Budget,
  summary: RunSummary,
): Promise<ReminderResult[]> {
  if (items.length === 0) return []
  const release = (): ReminderResult[] => items.map((i) => ({ id: i.reminderId, status: 'scheduled' }))

  if (!budget.take()) return release()
  const userIds = [...new Set(items.map((i) => i.userId))]
  const { data: devices, error } = await db
    .from('devices')
    .select('user_id, push_token')
    .in('user_id', userIds)
  if (error) {
    logError('devices', error.code)
    return items.map((i) => ({ id: i.reminderId, status: 'failed', error: 'devices_error' }))
  }

  const tokensByUser = new Map<string, string[]>()
  for (const d of devices) {
    const list = tokensByUser.get(d.user_id)
    if (list) list.push(d.push_token)
    else tokensByUser.set(d.user_id, [d.push_token])
  }

  const results: ReminderResult[] = []
  const outgoing: { reminderId: string; message: PushMessage }[] = []
  for (const item of items) {
    const tokens = tokensByUser.get(item.userId) ?? []
    if (tokens.length === 0) {
      results.push({ id: item.reminderId, status: 'skipped', error: 'no_devices' })
      continue
    }
    for (const to of tokens) {
      outgoing.push({
        reminderId: item.reminderId,
        message: {
          to,
          title: PUSH_TITLE,
          body: item.body,
          sound: 'default',
          data: { documentId: item.documentId },
        },
      })
    }
  }

  // Outcomes per reminder across all its devices; undefined = not attempted (budget).
  const outcomes = new Map<string, PushOutcome[]>()
  const deadTokens = new Set<string>()
  for (const part of chunk(outgoing, EXPO_CHUNK_SIZE)) {
    if (!budget.take()) break
    const sent = await sendPushChunk(
      part.map((p) => p.message),
      env.EXPO_ACCESS_TOKEN,
    )
    part.forEach((p, i) => {
      const outcome = sent[i] ?? { ok: false, error: 'expo_bad_response', deviceNotRegistered: false }
      if (!outcome.ok && outcome.deviceNotRegistered) deadTokens.add(p.message.to)
      const list = outcomes.get(p.reminderId)
      if (list) list.push(outcome)
      else outcomes.set(p.reminderId, [outcome])
    })
  }

  for (const reminderId of new Set(outgoing.map((p) => p.reminderId))) {
    const list = outcomes.get(reminderId)
    if (!list) {
      results.push({ id: reminderId, status: 'scheduled' })
    } else if (list.some((o) => o.ok)) {
      results.push({ id: reminderId, status: 'sent' })
    } else {
      const first = list.find((o) => !o.ok)
      results.push({ id: reminderId, status: 'failed', error: first && !first.ok ? first.error : 'expo_error' })
    }
  }

  // Without budget the dead tokens are simply found again next run.
  if (deadTokens.size > 0 && budget.take()) {
    const { error: delError } = await db.from('devices').delete().in('push_token', [...deadTokens])
    if (delError) logError('dead_tokens', delError.code)
    else summary.deadTokens += deadTokens.size
  }
  return results
}

async function deliverEmail(
  env: CronEnv,
  items: ReturnType<typeof planDelivery>['emails'],
  budget: Budget,
): Promise<ReminderResult[]> {
  const results: ReminderResult[] = []
  const mark = (
    ids: readonly string[],
    status: ReminderResult['status'],
    error?: string,
  ) => {
    for (const id of ids) results.push(error === undefined ? { id, status } : { id, status, error })
  }

  for (const part of chunk(items, RESEND_BATCH_SIZE)) {
    const emails: Email[] = part.map((item) => ({
      from: env.EMAIL_FROM,
      to: item.to,
      ...renderReminderEmail(item.lines),
    }))
    if (!budget.take()) {
      for (const item of part) mark(item.reminderIds, 'scheduled')
      continue
    }
    const outcome =
      emails.length === 1
        ? await sendEmail(emails[0] as Email, env.RESEND_API_KEY)
        : await sendEmailBatch(emails, env.RESEND_API_KEY)
    if (outcome.ok) {
      for (const item of part) mark(item.reminderIds, 'sent')
      continue
    }
    if (emails.length === 1 || !shouldRetryIndividually(outcome)) {
      for (const item of part) mark(item.reminderIds, 'failed', outcome.error)
      continue
    }
    // One bad email rejects the whole batch: retry one by one so it only fails its own user.
    for (const [i, item] of part.entries()) {
      if (!budget.take()) {
        mark(item.reminderIds, 'scheduled')
        continue
      }
      const single = await sendEmail(emails[i] as Email, env.RESEND_API_KEY)
      if (single.ok) mark(item.reminderIds, 'sent')
      else mark(item.reminderIds, 'failed', single.error)
    }
  }
  return results
}
