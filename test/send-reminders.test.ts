import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUBREQUEST_BUDGET, sendReminders } from '../src/cron/send-reminders'
import worker from '../src/index'
import type { PushMessage } from '../src/lib/push'
import { okTickets, reminder, setupCronFakes, type CronFakes } from './helpers/cron'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
// 02:00 UTC = 07:30 Colombo on 2026-10-20
const RUN_AT = Date.parse('2026-10-20T02:00:00Z')

let f: CronFakes
let logSpy: ReturnType<typeof vi.fn<typeof console.log>>
let errorSpy: ReturnType<typeof vi.fn<typeof console.error>>

beforeEach(() => {
  f = setupCronFakes()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const pushed = () => f.expoCalls.flat()
const deadTicket = (msg: PushMessage) => ({
  status: 'error',
  message: `"${msg.to}" is not a registered push notification recipient`,
  details: { error: 'DeviceNotRegistered' },
})

describe('sendReminders', () => {
  it('pushes to every device and sends one email per user, then a re-run sends nothing', async () => {
    const p = reminder({ channel: 'push' })
    const e1 = reminder({ channel: 'email' })
    const e2 = reminder({ channel: 'email', doc_type: 'revenue_licence', expiry_date: '2026-10-21' })
    f.reminders.push(p, e1, e2)
    f.devices.push(
      { user_id: USER_A, push_token: 'ExponentPushToken[a1]' },
      { user_id: USER_A, push_token: 'ExponentPushToken[a2]' },
    )

    const first = await sendReminders(f.env, RUN_AT)

    expect(pushed().map((m) => m.to)).toEqual(['ExponentPushToken[a1]', 'ExponentPushToken[a2]'])
    expect(pushed()[0]).toMatchObject({
      title: 'Vehicle Doc Lanka',
      body: 'Insurance · CAB-1234 expires in 5 days (25 Oct 2026)',
      data: { documentId: p.document_id },
    })
    expect(f.resendCalls).toHaveLength(1)
    const email = f.resendCalls[0]?.body as { to: string; subject: string; text: string }
    expect(email.to).toBe('a@example.com')
    expect(email.subject).toBe('2 documents need attention')
    // Soonest expiry first
    expect(email.text.indexOf('Revenue licence')).toBeLessThan(email.text.indexOf('Insurance'))
    for (const r of [p, e1, e2]) expect(f.status(r.id)).toEqual({ status: 'sent', error: null })
    expect(first).toMatchObject({ today: '2026-10-20', claimed: 3, sent: 3, failed: 0, skipped: 0 })

    const second = await sendReminders(f.env, RUN_AT)
    expect(f.expoCalls).toHaveLength(1)
    expect(f.resendCalls).toHaveLength(1)
    expect(second.claimed).toBe(0)
  })

  it('removes DeviceNotRegistered tokens and still counts the reminder sent via another device', async () => {
    const p = reminder()
    f.reminders.push(p)
    f.devices.push(
      { user_id: USER_A, push_token: 'ExponentPushToken[dead]' },
      { user_id: USER_A, push_token: 'ExponentPushToken[live]' },
    )
    f.expo = (messages) =>
      Response.json({
        data: messages.map((m) => (m.to.includes('dead') ? deadTicket(m) : { status: 'ok', id: 't' })),
      })

    const summary = await sendReminders(f.env, RUN_AT)

    expect(f.devices.map((d) => d.push_token)).toEqual(['ExponentPushToken[live]'])
    expect(f.status(p.id).status).toBe('sent')
    expect(summary.deadTokens).toBe(1)
  })

  it('skips deleted documents/vehicles and channels that are off, without sending', async () => {
    const rows = {
      docDeleted: reminder({ doc_deleted_at: '2026-10-19T00:00:00Z' }),
      vehicleDeleted: reminder({ channel: 'email', vehicle_deleted_at: '2026-10-19T00:00:00Z' }),
      profilePushOff: reminder({ profile_push_enabled: false }),
      docPushOff: reminder({ doc_push_enabled: false }),
      profileEmailOff: reminder({ channel: 'email', profile_email_enabled: false }),
      docEmailOff: reminder({ channel: 'email', doc_email_enabled: false }),
      noEmail: reminder({ channel: 'email', reminder_email: null, user_id: USER_B }),
      noDevices: reminder({ user_id: USER_B }),
    }
    f.reminders.push(...Object.values(rows))

    const summary = await sendReminders(f.env, RUN_AT)

    expect(f.expoCalls).toHaveLength(0)
    expect(f.resendCalls).toHaveLength(0)
    expect(f.status(rows.docDeleted.id)).toEqual({ status: 'skipped', error: 'document_deleted' })
    expect(f.status(rows.vehicleDeleted.id)).toEqual({ status: 'skipped', error: 'document_deleted' })
    expect(f.status(rows.profilePushOff.id)).toEqual({ status: 'skipped', error: 'push_off' })
    expect(f.status(rows.docPushOff.id)).toEqual({ status: 'skipped', error: 'push_off' })
    expect(f.status(rows.profileEmailOff.id)).toEqual({ status: 'skipped', error: 'email_off' })
    expect(f.status(rows.docEmailOff.id)).toEqual({ status: 'skipped', error: 'email_off' })
    expect(f.status(rows.noEmail.id)).toEqual({ status: 'skipped', error: 'no_email' })
    expect(f.status(rows.noDevices.id)).toEqual({ status: 'skipped', error: 'no_devices' })
    expect(summary.skipped).toBe(8)
  })

  it("isolates one user's push and email failures from another user", async () => {
    const aPush = reminder({ user_id: USER_A })
    const bPush = reminder({ user_id: USER_B })
    const aEmail = reminder({ user_id: USER_A, channel: 'email', reminder_email: 'bad@example.com' })
    const bEmail = reminder({ user_id: USER_B, channel: 'email', reminder_email: 'b@example.com' })
    f.reminders.push(aPush, bPush, aEmail, bEmail)
    f.devices.push(
      { user_id: USER_A, push_token: 'ExponentPushToken[dead]' },
      { user_id: USER_B, push_token: 'ExponentPushToken[b]' },
    )
    f.expo = (messages) =>
      Response.json({
        data: messages.map((m) => (m.to.includes('dead') ? deadTicket(m) : { status: 'ok', id: 't' })),
      })
    // The batch is rejected because of A's address; single sends then fail only A.
    f.resend = ({ url, body }) => {
      if (url.endsWith('/batch')) return Response.json({ message: 'invalid to' }, { status: 422 })
      const to = (body as { to: string }).to
      return to.startsWith('bad')
        ? Response.json({ message: 'invalid to' }, { status: 422 })
        : Response.json({ id: 'ok' })
    }

    await sendReminders(f.env, RUN_AT)

    expect(f.status(aPush.id)).toEqual({ status: 'failed', error: 'expo_DeviceNotRegistered' })
    expect(f.status(bPush.id)).toEqual({ status: 'sent', error: null })
    expect(f.resendCalls.map((c) => c.url.endsWith('/batch'))).toEqual([true, false, false])
    expect(f.status(aEmail.id)).toEqual({ status: 'failed', error: 'resend_422' })
    expect(f.status(bEmail.id)).toEqual({ status: 'sent', error: null })
  })

  it('fails a whole Expo chunk on a request error, with no token or text in the error', async () => {
    const p = reminder()
    f.reminders.push(p)
    f.devices.push({ user_id: USER_A, push_token: 'ExponentPushToken[a1]' })
    f.expo = () => Response.json({ errors: [{ code: 'INTERNAL' }] }, { status: 503 })

    await sendReminders(f.env, RUN_AT)

    expect(f.status(p.id)).toEqual({ status: 'failed', error: 'expo_503' })
  })

  it('sends only the nearest of several due rows for the same document and channel', async () => {
    const doc = 'dddddddd-0000-4000-8000-0000000000ff'
    const older = reminder({ document_id: doc, days_before: 7, send_on: '2026-10-18' })
    const nearer = reminder({ document_id: doc, days_before: 5, send_on: '2026-10-20' })
    f.reminders.push(older, nearer)
    f.devices.push({ user_id: USER_A, push_token: 'ExponentPushToken[a1]' })

    await sendReminders(f.env, RUN_AT)

    expect(pushed()).toHaveLength(1)
    expect(f.status(nearer.id).status).toBe('sent')
    expect(f.status(older.id)).toEqual({ status: 'skipped', error: 'superseded' })
  })

  it('uses Colombo "today", not UTC', async () => {
    // 19:00 UTC on the 19th is already 00:30 on the 20th in Colombo.
    f.reminders.push(reminder({ send_on: '2026-10-20' }))
    const summary = await sendReminders(f.env, Date.parse('2026-10-19T19:00:00Z'))
    expect(summary.today).toBe('2026-10-20')
    expect(summary.claimed).toBe(1)
    const claim = f.supabaseCalls.find((c) => c.path.endsWith('claim_due_reminders'))
    expect(claim?.body).toMatchObject({ p_today: '2026-10-20' })

    // 18:00 UTC on the 19th is still the 19th in Colombo: not due yet.
    const g = setupCronFakes()
    g.reminders.push(reminder({ send_on: '2026-10-20' }))
    expect((await sendReminders(g.env, Date.parse('2026-10-19T18:00:00Z'))).claimed).toBe(0)
  })

  it('stays within the subrequest budget and leaves the rest scheduled', async () => {
    for (let i = 0; i < 1500; i++) {
      const user = `33333333-3333-4333-8333-${i.toString().padStart(12, '0')}`
      f.reminders.push(reminder({ user_id: user }))
      f.devices.push({ user_id: user, push_token: `ExponentPushToken[${i}]` })
    }
    f.expo = okTickets

    const summary = await sendReminders(f.env, RUN_AT)

    const total = f.supabaseCalls.length + f.expoCalls.length + f.resendCalls.length
    expect(total).toBe(summary.subrequests)
    expect(total).toBeLessThanOrEqual(SUBREQUEST_BUDGET)
    expect(f.reminders.some((r) => r.status === 'sending')).toBe(false)
    expect(f.reminders.filter((r) => r.status === 'sent')).toHaveLength(summary.sent)
    expect(f.reminders.filter((r) => r.status === 'scheduled').length).toBeGreaterThan(0)
  })

  it('does not throw or send when the claim fails', async () => {
    f.claimError = true
    f.reminders.push(reminder())
    const summary = await sendReminders(f.env, RUN_AT)
    expect(summary.claimed).toBe(0)
    expect(f.expoCalls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('never logs tokens, emails or plates', async () => {
    f.reminders.push(reminder(), reminder({ channel: 'email' }))
    f.devices.push({ user_id: USER_A, push_token: 'ExponentPushToken[secret]' })
    f.expo = (messages) => Response.json({ data: messages.map(deadTicket) })
    f.resend = () => Response.json({ message: 'a@example.com is invalid' }, { status: 422 })
    await sendReminders(f.env, RUN_AT)
    const logged = JSON.stringify([
      logSpy.mock.calls,
      errorSpy.mock.calls,
      f.reminders.map((r) => r.error),
    ])
    expect(logged).not.toContain('ExponentPushToken')
    expect(logged).not.toContain('@example.com')
    expect(logged).not.toContain('CAB-1234')
  })
})

describe('scheduled()', () => {
  it('runs sendReminders via ctx.waitUntil', async () => {
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
    const ctx = { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
    const controller = { scheduledTime: RUN_AT, cron: '0 2 * * *', noRetry: () => {} } as ScheduledController
    await worker.scheduled(controller, { ...f.env } as unknown as CloudflareBindings, ctx)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    expect(f.supabaseCalls[0]?.path).toBe('/rest/v1/rpc/claim_due_reminders')
  })
})
