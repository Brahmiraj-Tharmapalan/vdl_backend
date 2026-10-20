import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tables } from '../src/types/db'
import { expectCamelCase, expectError, setupHarness, USER_A, type Harness } from './helpers/api'

const VEHICLE_ID = '44444444-4444-4444-8444-444444444444'

const vehicle = {
  id: VEHICLE_ID,
  nickname: 'Car',
  plate_number: 'CAB-1234',
  type: 'car',
  deleted_at: null,
}

const doc = (over: Partial<Tables<'documents'>> = {}): Tables<'documents'> => ({
  id: '55555555-5555-4555-8555-555555555555',
  user_id: USER_A,
  vehicle_id: VEHICLE_ID,
  type: 'insurance',
  custom_name: null,
  expiry_date: '2026-10-25',
  reminder_days: [30, 7, 1],
  push_enabled: true,
  email_enabled: true,
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T00:00:00+00:00',
  client_updated_at: '2026-10-20T00:00:00+00:00',
  deleted_at: null,
  ...over,
})

const reminderRow = {
  id: '66666666-6666-4666-8666-666666666666',
  user_id: USER_A,
  document_id: '55555555-5555-4555-8555-555555555555',
  days_before: 5,
  send_on: '2026-10-20',
  channel: 'email',
  status: 'scheduled',
  sent_at: null,
  error: null,
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T00:00:00+00:00',
  client_updated_at: '2026-10-20T00:00:00+00:00',
  documents: {
    type: 'insurance',
    custom_name: null,
    expiry_date: '2026-10-25',
    deleted_at: null,
    vehicles: { nickname: 'Car', plate_number: 'CAB-1234', type: 'car', deleted_at: null },
  },
}

let h: Harness

beforeEach(async () => {
  h = await setupHarness()
  vi.useFakeTimers({ toFake: ['Date'] })
  // 2026-10-20 in Colombo, still 2026-10-19 in UTC.
  vi.setSystemTime(new Date('2026-10-19T20:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type DashboardJson = {
  counts: { vehicles: number; documents: number; toRenew: number }
  upcoming: Array<Record<string, unknown> & { vehicle: Record<string, unknown> }>
}

describe('GET /v1/dashboard', () => {
  it('needs a token', async () => {
    await expectError(await h.call('/v1/dashboard'), 401, 'unauthorized')
  })

  it('returns zero counts for an empty account', async () => {
    h.supabase(() => Response.json([]))
    const res = await h.authed('/v1/dashboard')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      counts: { vehicles: 0, documents: 0, toRenew: 0 },
      upcoming: [],
    })
  })

  it('queries only the user’s live rows and returns camelCase items', async () => {
    h.supabase(({ url }) =>
      Response.json(url.pathname.endsWith('/vehicles') ? [vehicle] : [doc()]),
    )
    const res = await h.authed('/v1/dashboard')
    expect(res.status).toBe(200)
    const body = await res.json<DashboardJson>()
    expect(body.counts).toEqual({ vehicles: 1, documents: 1, toRenew: 1 })
    const [item] = body.upcoming
    expect(item).toMatchObject({ status: 'expiring_soon', daysLeft: 5 })
    expect(item?.vehicle).toEqual({ nickname: 'Car', plateNumber: 'CAB-1234', type: 'car' })
    if (item) expectCamelCase(item)
    expect(JSON.stringify(body)).not.toContain(USER_A)

    expect(h.calls).toHaveLength(2)
    for (const call of h.calls) {
      expect(call.method).toBe('GET')
      expect(call.url.searchParams.get('user_id')).toBe(`eq.${USER_A}`)
      expect(call.url.searchParams.get('deleted_at')).toBe('is.null')
    }
  })

  it('returns a generic 500 on a database error', async () => {
    h.supabase(() => Response.json({ message: 'boom', code: 'XX000' }, { status: 500 }))
    const body = await expectError(await h.authed('/v1/dashboard'), 500, 'internal_error')
    expect(JSON.stringify(body)).not.toContain('boom')
  })
})

describe('GET /v1/reminders/upcoming', () => {
  it('needs a token', async () => {
    await expectError(await h.call('/v1/reminders/upcoming'), 401, 'unauthorized')
  })

  it('returns scheduled reminders from Colombo today with document and vehicle info', async () => {
    h.supabase(() => Response.json([reminderRow]))
    const res = await h.authed('/v1/reminders/upcoming')
    expect(res.status).toBe(200)
    const body = await res.json<{ reminders: Array<Record<string, unknown>> }>()
    expect(body.reminders).toEqual([
      {
        id: reminderRow.id,
        documentId: reminderRow.document_id,
        daysBefore: 5,
        sendOn: '2026-10-20',
        channel: 'email',
        status: 'scheduled',
        sentAt: null,
        document: { type: 'insurance', customName: null, expiryDate: '2026-10-25' },
        vehicle: { nickname: 'Car', plateNumber: 'CAB-1234', type: 'car' },
      },
    ])

    const q = h.calls[0]?.url.searchParams
    expect(q?.get('user_id')).toBe(`eq.${USER_A}`)
    expect(q?.get('status')).toBe('eq.scheduled')
    expect(q?.get('send_on')).toBe('gte.2026-10-20')
    expect(q?.get('documents.deleted_at')).toBe('is.null')
    expect(q?.get('documents.vehicles.deleted_at')).toBe('is.null')
    expect(q?.get('order')).toBe('send_on.asc,id.asc')
    expect(q?.get('limit')).toBe('50')
    expect(q?.get('select')).toContain('documents!inner(')
  })

  it('returns an empty list', async () => {
    h.supabase(() => Response.json([]))
    const res = await h.authed('/v1/reminders/upcoming')
    expect(await res.json()).toEqual({ reminders: [] })
  })

  it('passes a valid limit through', async () => {
    h.supabase(() => Response.json([]))
    const res = await h.authed('/v1/reminders/upcoming?limit=100')
    expect(res.status).toBe(200)
    expect(h.calls[0]?.url.searchParams.get('limit')).toBe('100')
  })

  it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'foo=1'])(
    'rejects %s with 400',
    async (query) => {
      await expectError(await h.authed(`/v1/reminders/upcoming?${query}`), 400, 'validation_failed')
      expect(h.calls).toHaveLength(0)
    },
  )
})
