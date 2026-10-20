// Fakes for cron tests: one fetch stub routed by host, with an in-memory Supabase that implements
// the claim/finish RPCs and the devices table, plus recording Expo and Resend responders.
import { env } from 'cloudflare:workers'
import { vi } from 'vitest'
import type { PushMessage } from '../../src/lib/push'
import type { DueReminder } from '../../src/lib/reminder-message'

export type FakeReminder = DueReminder & {
  status: string
  error: string | null
  sent_at: string | null
}
export type FakeDevice = { user_id: string; push_token: string }

type ResendCall = { url: string; body: unknown }

export type CronFakes = {
  reminders: FakeReminder[]
  devices: FakeDevice[]
  expoCalls: PushMessage[][]
  resendCalls: ResendCall[]
  supabaseCalls: { method: string; path: string; body: unknown }[]
  /** Replace to return custom tickets or errors. Default: every ticket ok. */
  expo: (messages: PushMessage[]) => Response
  /** Replace to fail some sends. Default: 200. */
  resend: (call: ResendCall) => Response
  /** Set to make the claim RPC fail. */
  claimError: boolean
  env: Parameters<typeof import('../../src/cron/send-reminders').sendReminders>[0]
  status: (id: string) => { status: string; error: string | null }
}

export const okTickets = (messages: PushMessage[]) =>
  Response.json({ data: messages.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })) })

const inList = (value: string | null): string[] =>
  (value ?? '')
    .replace(/^in\.\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((v) => v.replace(/^"|"$/g, ''))

export function setupCronFakes(): CronFakes {
  const fakes: CronFakes = {
    reminders: [],
    devices: [],
    expoCalls: [],
    resendCalls: [],
    supabaseCalls: [],
    expo: okTickets,
    resend: ({ url, body }) =>
      url.endsWith('/batch')
        ? Response.json({ data: (body as unknown[]).map((_, i) => ({ id: `email-${i}` })) })
        : Response.json({ id: 'email-1' }),
    claimError: false,
    env: {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
      EXPO_ACCESS_TOKEN: 'test-expo-token',
      RESEND_API_KEY: 'test-resend-key',
      EMAIL_FROM: 'Vehicle Doc Lanka <reminders@example.com>',
    },
    status: (id) => {
      const r = fakes.reminders.find((x) => x.id === id)
      if (!r) throw new Error(`no reminder ${id}`)
      return { status: r.status, error: r.error }
    },
  }

  const claim = (body: { p_today: string; p_limit: number }) => {
    const due = fakes.reminders
      .filter((r) => r.status === 'scheduled' && r.send_on <= body.p_today)
      .sort((a, b) => (a.user_id + a.id < b.user_id + b.id ? -1 : 1))
    const users = new Set(due.slice(0, body.p_limit).map((r) => r.user_id))
    const claimed = due.filter((r) => users.has(r.user_id))
    for (const r of claimed) r.status = 'sending'
    return claimed.map(({ status: _s, error: _e, sent_at: _t, ...row }) => row)
  }

  const finish = (body: { p_results: { id: string; status: string; error?: string }[] }) => {
    for (const res of body.p_results) {
      const r = fakes.reminders.find((x) => x.id === res.id)
      if (!r || r.status !== 'sending') continue
      r.status = res.status
      r.error = res.error ?? null
      r.sent_at = res.status === 'sent' ? new Date().toISOString() : null
    }
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const text = await req.text()
    const body: unknown = text ? JSON.parse(text) : undefined

    if (url.host === 'exp.host') {
      const messages = body as PushMessage[]
      fakes.expoCalls.push(messages)
      return fakes.expo(messages)
    }
    if (url.host === 'api.resend.com') {
      const call = { url: req.url, body }
      fakes.resendCalls.push(call)
      return fakes.resend(call)
    }
    if (!req.url.startsWith(env.SUPABASE_URL)) throw new Error(`unexpected fetch ${req.url}`)

    fakes.supabaseCalls.push({ method: req.method, path: url.pathname, body })
    if (url.pathname === '/rest/v1/rpc/claim_due_reminders') {
      if (fakes.claimError) {
        return Response.json({ code: 'XX000', message: 'boom' }, { status: 500 })
      }
      return Response.json(claim(body as { p_today: string; p_limit: number }))
    }
    if (url.pathname === '/rest/v1/rpc/finish_reminders') {
      finish(body as { p_results: { id: string; status: string; error?: string }[] })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/rest/v1/devices' && req.method === 'GET') {
      const ids = inList(url.searchParams.get('user_id'))
      return Response.json(
        fakes.devices
          .filter((d) => ids.includes(d.user_id))
          .map((d) => ({ user_id: d.user_id, push_token: d.push_token })),
      )
    }
    if (url.pathname === '/rest/v1/devices' && req.method === 'DELETE') {
      const tokens = inList(url.searchParams.get('push_token'))
      fakes.devices = fakes.devices.filter((d) => !tokens.includes(d.push_token))
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected Supabase call ${req.method} ${url.pathname}`)
  })

  return fakes
}

let seq = 0

/** A due `scheduled` reminder row (insurance, CAB-1234, both channels on everywhere). */
export function reminder(over: Partial<FakeReminder> = {}): FakeReminder {
  seq++
  const hex = seq.toString(16).padStart(12, '0')
  return {
    id: `rrrrrrrr-0000-4000-8000-${hex}`.replace(/r/g, 'a'),
    user_id: '11111111-1111-4111-8111-111111111111',
    document_id: `dddddddd-0000-4000-8000-${hex}`,
    days_before: 5,
    send_on: '2026-10-20',
    channel: 'push',
    doc_type: 'insurance',
    custom_name: null,
    expiry_date: '2026-10-25',
    doc_push_enabled: true,
    doc_email_enabled: true,
    doc_deleted_at: null,
    plate_number: 'CAB-1234',
    nickname: null,
    vehicle_deleted_at: null,
    profile_push_enabled: true,
    profile_email_enabled: true,
    reminder_email: 'a@example.com',
    status: 'scheduled',
    error: null,
    sent_at: null,
    ...over,
  }
}
