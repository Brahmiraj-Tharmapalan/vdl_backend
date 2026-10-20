import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rebuildReminders } from '../src/lib/reminders'
import type { Tables } from '../src/types/db'
import {
  expectCamelCase,
  expectError,
  json,
  setupHarness,
  USER_A,
  USER_B,
  type Harness,
} from './helpers/api'

vi.mock('../src/lib/reminders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/reminders')>()
  return { ...actual, rebuildReminders: vi.fn(async () => {}) }
})

const VEHICLE_ID = '44444444-4444-4444-8444-444444444444'
const DOC_ID = '55555555-5555-4555-8555-555555555555'

const doc = (over: Partial<Tables<'documents'>> = {}): Tables<'documents'> => ({
  id: DOC_ID,
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
  deleted_at: null,
  ...over,
})

let h: Harness

beforeEach(async () => {
  h = await setupHarness()
  vi.useFakeTimers({ toFake: ['Date'] })
  // 2026-10-20 in Colombo.
  vi.setSystemTime(new Date('2026-10-20T06:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(rebuildReminders).mockClear()
})

describe('GET /v1/documents', () => {
  const rows = [
    doc({ id: '00000000-0000-4000-8000-000000000001', expiry_date: '2026-10-19' }), // expired
    doc({ id: '00000000-0000-4000-8000-000000000002', expiry_date: '2026-11-19' }), // day 30
    doc({ id: '00000000-0000-4000-8000-000000000003', expiry_date: '2026-11-20' }), // day 31
  ]
  const list = async (query = '') => {
    h.supabase(() => Response.json(rows))
    const res = await h.authed(`/v1/documents${query}`)
    expect(res.status).toBe(200)
    return res.json<{ documents: { id: string; status: string }[] }>()
  }

  it('lists live documents with computed status, camelCase, no user_id', async () => {
    const body = await list()
    expect(body.documents.map((d) => d.status)).toEqual(['expired', 'expiring_soon', 'valid'])
    for (const d of body.documents) expectCamelCase(d)
    expect(JSON.stringify(body)).not.toContain(USER_A)
    const params = h.calls[0]?.url.searchParams
    expect(params?.get('user_id')).toBe(`eq.${USER_A}`)
    expect(params?.get('deleted_at')).toBe('is.null')
  })

  it('filter=to_renew returns expired + expiring soon', async () => {
    const body = await list('?filter=to_renew')
    expect(body.documents.map((d) => d.status)).toEqual(['expired', 'expiring_soon'])
  })

  it('filter=valid returns only valid', async () => {
    const body = await list('?filter=valid')
    expect(body.documents.map((d) => d.status)).toEqual(['valid'])
  })

  it.each(['?filter=soon', '?filter=all&x=1'])('rejects %s with 400', async (q) => {
    await expectError(await h.authed(`/v1/documents${q}`), 400, 'validation_failed')
  })
})

describe('GET /v1/documents/:id', () => {
  it('returns the live document', async () => {
    h.supabase(() => Response.json([doc()]))
    const res = await h.authed(`/v1/documents/${DOC_ID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: DOC_ID, status: 'expiring_soon', daysLeft: 5 })
    expect(h.calls[0]?.url.searchParams.get('deleted_at')).toBe('is.null')
  })

  it("returns 404 for user B on user A's document", async () => {
    h.supabase(() => Response.json([]))
    await expectError(await h.authed(`/v1/documents/${DOC_ID}`, {}, USER_B), 404, 'not_found')
  })

  it('rejects a bad UUID with 400', async () => {
    await expectError(await h.authed('/v1/documents/xyz'), 400, 'validation_failed')
  })
})

describe('PATCH /v1/documents/:id', () => {
  const patch = (body: unknown, sub?: string) =>
    h.authed(`/v1/documents/${DOC_ID}`, { method: 'PATCH', ...json(body) }, sub)

  /** GET returns `current`; the PATCH echoes current merged with the update body. */
  const stub = (current: Tables<'documents'> | null = doc()) =>
    h.supabase((call) => {
      if (call.method === 'GET') return Response.json(current ? [current] : [])
      return Response.json([{ ...current, ...(call.body as object) }])
    })

  it('renews: a new expiryDate updates and rebuilds reminders', async () => {
    stub()
    const res = await patch({ expiryDate: '2027-10-25' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ expiryDate: '2027-10-25', status: 'valid' })
    expect(h.calls[1]?.body).toEqual({ expiry_date: '2027-10-25' })
    expect(rebuildReminders).toHaveBeenCalledTimes(1)
    expect(rebuildReminders).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: DOC_ID }))
  })

  it.each([
    ['reminderDays', { reminderDays: [10] }],
    ['pushEnabled', { pushEnabled: false }],
    ['emailEnabled', { emailEnabled: false }],
  ])('rebuilds reminders when %s changes', async (_name, body) => {
    stub()
    await patch(body)
    expect(rebuildReminders).toHaveBeenCalledTimes(1)
    expect(rebuildReminders).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: DOC_ID }))
  })

  it('does not rebuild when only non-reminder fields change', async () => {
    stub(doc({ type: 'custom', custom_name: 'Permit' }))
    const res = await patch({ customName: 'Route permit' })
    expect(res.status).toBe(200)
    expect(rebuildReminders).not.toHaveBeenCalled()
  })

  it('does not rebuild when the values are unchanged', async () => {
    stub()
    await patch({ expiryDate: '2026-10-25', reminderDays: [30, 7, 1] })
    expect(rebuildReminders).not.toHaveBeenCalled()
  })

  it('switching away from custom clears customName', async () => {
    stub(doc({ type: 'custom', custom_name: 'Permit' }))
    const res = await patch({ type: 'insurance' })
    expect(res.status).toBe(200)
    expect(h.calls[1]?.body).toEqual({ type: 'insurance', custom_name: null })
  })

  it('switching to custom without a customName is a 400', async () => {
    stub()
    await expectError(await patch({ type: 'custom' }), 400, 'validation_failed')
    expect(h.calls).toHaveLength(1)
  })

  it('customName on a non-custom document is a 400', async () => {
    stub()
    await expectError(await patch({ customName: 'Permit' }), 400, 'validation_failed')
  })

  it("returns 404 for user B on user A's document", async () => {
    stub(null)
    await expectError(await patch({ expiryDate: '2027-01-01' }, USER_B), 404, 'not_found')
    expect(h.calls).toHaveLength(1)
    expect(rebuildReminders).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty body', {}],
    ['a vehicleId change', { vehicleId: VEHICLE_ID }],
    ['a bad date', { expiryDate: '25-10-2026' }],
    ['a too-long customName', { customName: 'x'.repeat(51) }],
  ])('rejects %s with 400', async (_name, body) => {
    await expectError(await patch(body), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })
})

describe('DELETE /v1/documents/:id', () => {
  const remove = (sub?: string) =>
    h.authed(`/v1/documents/${DOC_ID}`, { method: 'DELETE' }, sub)

  it('soft-deletes and rebuilds reminders', async () => {
    h.supabase(() => Response.json([doc({ deleted_at: '2026-10-20T06:00:00.000Z' })]))
    const res = await remove()
    expect(res.status).toBe(204)
    const [call] = h.calls
    expect(call?.method).toBe('PATCH')
    expect(call?.body).toEqual({ deleted_at: '2026-10-20T06:00:00.000Z' })
    expect(call?.url.searchParams.get('deleted_at')).toBe('is.null')
    expect(rebuildReminders).toHaveBeenCalledTimes(1)
    expect(rebuildReminders).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: DOC_ID }))
  })

  it("returns 404 for user B on user A's (or an already deleted) document", async () => {
    h.supabase(() => Response.json([]))
    await expectError(await remove(USER_B), 404, 'not_found')
    expect(rebuildReminders).not.toHaveBeenCalled()
  })
})
