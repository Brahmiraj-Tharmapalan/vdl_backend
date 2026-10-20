import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { todayInColombo } from '../src/lib/dates'
import {
  buildReminderRows,
  rebuildAllReminders,
  rebuildReminders,
  remindersChanged,
} from '../src/lib/reminders'
import { userClient } from '../src/lib/supabase'
import type { Tables } from '../src/types/db'
import { bearerSub, setupHarness, USER_A, type Harness } from './helpers/api'

const doc = (over: Partial<Tables<'documents'>> = {}): Tables<'documents'> => ({
  id: '55555555-5555-4555-8555-555555555555',
  user_id: '11111111-1111-4111-8111-111111111111',
  vehicle_id: '44444444-4444-4444-8444-444444444444',
  type: 'insurance',
  custom_name: null,
  expiry_date: '2026-10-25',
  reminder_days: [30, 7, 1],
  push_enabled: true,
  email_enabled: true,
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T00:00:00+00:00',
  deleted_at: null,
  ...over,
})

describe('remindersChanged', () => {
  it('is false for identical reminder fields', () => {
    expect(remindersChanged(doc(), doc({ updated_at: 'later', custom_name: 'x' }))).toBe(false)
  })

  it.each([
    ['expiry date', { expiry_date: '2027-10-25' }],
    ['reminder days', { reminder_days: [30, 7] }],
    ['reminder day order', { reminder_days: [1, 7, 30] }],
    ['push toggle', { push_enabled: false }],
    ['email toggle', { email_enabled: false }],
    ['soft delete', { deleted_at: '2026-10-20T00:00:00Z' }],
  ])('is true when the %s changes', (_name, over) => {
    expect(remindersChanged(doc(), doc(over))).toBe(true)
  })
})

const on = { push_enabled: true, email_enabled: true }
const TODAY = '2026-10-20'

describe('buildReminderRows', () => {
  it('builds one row per day and channel with send_on = expiry - days', () => {
    expect(buildReminderRows(doc({ expiry_date: '2026-12-31', reminder_days: [30, 1] }), on, TODAY)).toEqual([
      { days_before: 30, send_on: '2026-12-01', channel: 'push' },
      { days_before: 30, send_on: '2026-12-01', channel: 'email' },
      { days_before: 1, send_on: '2026-12-30', channel: 'push' },
      { days_before: 1, send_on: '2026-12-30', channel: 'email' },
    ])
  })

  it.each([
    // [profile push, profile email, doc push, doc email, expected channels]
    [true, true, true, true, ['push', 'email']],
    [true, true, true, false, ['push']],
    [true, true, false, true, ['email']],
    [true, true, false, false, []],
    [false, true, true, true, ['email']],
    [true, false, true, true, ['push']],
    [false, false, true, true, []],
    [false, true, true, false, []],
  ])(
    'profile push=%s email=%s, doc push=%s email=%s → %j',
    (pPush, pEmail, dPush, dEmail, expected) => {
      const rows = buildReminderRows(
        doc({ expiry_date: '2026-12-31', reminder_days: [7], push_enabled: dPush, email_enabled: dEmail }),
        { push_enabled: pPush, email_enabled: pEmail },
        TODAY,
      )
      expect(rows.map((r) => r.channel)).toEqual(expected)
    },
  )

  it('keeps send_on = today and skips earlier dates', () => {
    // expiry 2026-10-25: 30 → 09-25 (past), 5 → 10-20 (today), 1 → 10-24
    const rows = buildReminderRows(doc({ reminder_days: [30, 5, 1], email_enabled: false }), on, TODAY)
    expect(rows).toEqual([
      { days_before: 5, send_on: '2026-10-20', channel: 'push' },
      { days_before: 1, send_on: '2026-10-24', channel: 'push' },
    ])
  })

  it('returns [] for an expired document', () => {
    expect(buildReminderRows(doc({ expiry_date: '2026-10-19' }), on, TODAY)).toEqual([])
  })

  it('returns [] for a deleted document', () => {
    expect(buildReminderRows(doc({ deleted_at: '2026-10-20T00:00:00Z' }), on, TODAY)).toEqual([])
  })

  it('returns [] with no reminder days', () => {
    expect(buildReminderRows(doc({ reminder_days: [] }), on, TODAY)).toEqual([])
  })

  it.each([
    ['leap day', '2028-03-01', 1, '2028-02-29'],
    ['non-leap February', '2027-03-01', 1, '2027-02-28'],
    ['month end', '2027-03-31', 30, '2027-03-01'],
    ['year boundary', '2027-01-05', 10, '2026-12-26'],
    ['a full year', '2027-10-20', 365, '2026-10-20'],
  ])('handles %s', (_name, expiry, days, sendOn) => {
    const rows = buildReminderRows(doc({ expiry_date: expiry, reminder_days: [days] }), on, TODAY)
    expect(rows[0]?.send_on).toBe(sendOn)
  })

  it('uses Colombo "today": 2026-10-19T19:00Z is already the 20th in Colombo', () => {
    const today = todayInColombo(new Date('2026-10-19T19:00:00Z'))
    expect(today).toBe('2026-10-20')
    // 6 days before 2026-10-25 is the 19th: skipped in Colombo, though it is still the 19th in UTC.
    expect(buildReminderRows(doc({ reminder_days: [6] }), on, today)).toEqual([])
  })
})

describe('rebuildReminders / rebuildAllReminders', () => {
  let h: Harness

  beforeEach(async () => {
    h = await setupHarness()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const client = async () => userClient(
    { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: 'test-anon-key' },
    await h.token(),
  )

  it('calls the rebuild_reminders RPC with the document id as the user', async () => {
    h.supabase(() => new Response(null, { status: 204 }))
    await rebuildReminders(await client(), doc())
    expect(h.calls).toHaveLength(1)
    const [call] = h.calls
    expect(call?.method).toBe('POST')
    expect(call?.url.pathname).toBe('/rest/v1/rpc/rebuild_reminders')
    expect(call?.body).toEqual({ p_document_ids: [doc().id] })
    expect(bearerSub(call?.authorization)).toBe(USER_A)
  })

  it('rebuildAllReminders omits the ids (all live documents)', async () => {
    h.supabase(() => new Response(null, { status: 204 }))
    await rebuildAllReminders(await client())
    expect(h.calls[0]?.body).toEqual({})
  })

  it('throws a generic error on failure', async () => {
    h.supabase(() => Response.json({ code: '42501', message: 'denied' }, { status: 403 }))
    await expect(rebuildReminders(await client(), doc())).rejects.toThrow('Supabase error 42501')
  })
})
