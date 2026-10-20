import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rebuildReminders } from '../src/lib/reminders'
import type { Tables } from '../src/types/db'
import {
  bearerSub,
  expectCamelCase,
  expectError,
  json,
  setupHarness,
  USER_A,
  USER_B,
  type Harness,
  type SupabaseCall,
} from './helpers/api'

vi.mock('../src/lib/reminders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/reminders')>()
  return { ...actual, rebuildReminders: vi.fn(async () => {}) }
})

const VEHICLE_ID = '44444444-4444-4444-8444-444444444444'
const DOC_ID = '55555555-5555-4555-8555-555555555555'

const vehicle = (over: Partial<Tables<'vehicles'>> = {}): Tables<'vehicles'> => ({
  id: VEHICLE_ID,
  user_id: USER_A,
  nickname: 'Family car',
  plate_number: 'CAB-1234',
  type: 'car',
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T00:00:00+00:00',
  deleted_at: null,
  ...over,
})

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

const apiVehicle = {
  id: VEHICLE_ID,
  nickname: 'Family car',
  plateNumber: 'CAB-1234',
  type: 'car',
  createdAt: '2026-10-19T00:00:00+00:00',
  updatedAt: '2026-10-20T00:00:00+00:00',
  deletedAt: null,
}

const table = (call: SupabaseCall) => call.url.pathname.replace('/rest/v1/', '')

let h: Harness

beforeEach(async () => {
  h = await setupHarness()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T06:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(rebuildReminders).mockClear()
})

describe('GET /v1/vehicles', () => {
  it('lists live vehicles in camelCase without user_id', async () => {
    h.supabase(() => Response.json([vehicle()]))
    const res = await h.authed('/v1/vehicles')
    expect(res.status).toBe(200)
    const body = await res.json<{ vehicles: Record<string, unknown>[] }>()
    expect(body).toEqual({ vehicles: [apiVehicle] })
    expectCamelCase(body.vehicles[0] ?? {})
    const params = h.calls[0]?.url.searchParams
    expect(params?.get('user_id')).toBe(`eq.${USER_A}`)
    expect(params?.get('deleted_at')).toBe('is.null')
  })
})

describe('POST /v1/vehicles', () => {
  const create = (body: unknown, sub?: string) =>
    h.authed('/v1/vehicles', { method: 'POST', ...json(body) }, sub)
  const valid = { id: VEHICLE_ID, nickname: 'Family car', plateNumber: 'CAB-1234', type: 'car' }

  it('inserts with on conflict do nothing and returns 201', async () => {
    h.supabase(() => Response.json([vehicle()]))
    const res = await create({ ...valid, plateNumber: '  cab-1234 ' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(apiVehicle)
    const [call] = h.calls
    expect(call?.method).toBe('POST')
    expect(call?.url.searchParams.get('on_conflict')).toBe('id')
    // Plate trimmed + uppercased; user_id from the JWT.
    expect(call?.body).toEqual({
      id: VEHICLE_ID,
      user_id: USER_A,
      nickname: 'Family car',
      plate_number: 'CAB-1234',
      type: 'car',
    })
    expect(bearerSub(call?.authorization)).toBe(USER_A)
  })

  it('updates the existing live row and returns 200', async () => {
    h.supabase((call) => Response.json(call.method === 'POST' ? [] : [vehicle()]))
    const res = await create({ id: VEHICLE_ID, plateNumber: 'CAB-1234', type: 'car' })
    expect(res.status).toBe(200)
    const update = h.calls[1]
    expect(update?.method).toBe('PATCH')
    expect(update?.url.searchParams.get('id')).toBe(`eq.${VEHICLE_ID}`)
    expect(update?.url.searchParams.get('deleted_at')).toBe('is.null')
    // Full representation: a missing nickname resets to null.
    expect(update?.body).toEqual({ nickname: null, plate_number: 'CAB-1234', type: 'car' })
  })

  it("returns 409 when the id is another user's or a deleted row", async () => {
    h.supabase(() => Response.json([]))
    const body = await expectError(await create(valid, USER_B), 409, 'conflict')
    expect(body.error.message).toBe('This id is already in use')
  })

  it.each([
    ['an unknown field', { ...valid, userId: USER_B }],
    ['a bad UUID', { ...valid, id: 'not-a-uuid' }],
    ['a bad plate', { ...valid, plateNumber: 'CAB_1234!' }],
    ['a too-long plate', { ...valid, plateNumber: 'A'.repeat(16) }],
    ['a too-long nickname', { ...valid, nickname: 'x'.repeat(51) }],
    ['a bad type', { ...valid, type: 'truck' }],
    ['a missing plate', { id: VEHICLE_ID, type: 'car' }],
  ])('rejects %s with 400', async (_name, body) => {
    await expectError(await create(body), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects an oversized body with 413', async () => {
    await expectError(await create({ ...valid, nickname: 'x'.repeat(101 * 1024) }), 413, 'payload_too_large')
  })
})

describe('GET /v1/vehicles/:id', () => {
  it('returns the live vehicle', async () => {
    h.supabase(() => Response.json([vehicle()]))
    const res = await h.authed(`/v1/vehicles/${VEHICLE_ID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(apiVehicle)
    expect(h.calls[0]?.url.searchParams.get('deleted_at')).toBe('is.null')
  })

  it("returns 404 for user B on user A's (or a deleted) vehicle", async () => {
    h.supabase(() => Response.json([]))
    await expectError(await h.authed(`/v1/vehicles/${VEHICLE_ID}`, {}, USER_B), 404, 'not_found')
  })

  it('rejects a bad UUID with 400', async () => {
    await expectError(await h.authed('/v1/vehicles/123'), 400, 'validation_failed')
  })
})

describe('PATCH /v1/vehicles/:id', () => {
  const patch = (body: unknown, sub?: string) =>
    h.authed(`/v1/vehicles/${VEHICLE_ID}`, { method: 'PATCH', ...json(body) }, sub)

  it('sends only the given fields', async () => {
    h.supabase(() => Response.json([vehicle({ plate_number: 'WP-9999' })]))
    const res = await patch({ plateNumber: 'wp-9999' })
    expect(res.status).toBe(200)
    expect(h.calls[0]?.body).toEqual({ plate_number: 'WP-9999' })
  })

  it("returns 404 for user B on user A's vehicle", async () => {
    h.supabase(() => Response.json([]))
    await expectError(await patch({ nickname: 'Mine' }, USER_B), 404, 'not_found')
  })

  it.each([
    ['an empty body', {}],
    ['an id change', { id: VEHICLE_ID }],
    ['a bad plate', { plateNumber: 'ABC#1' }],
  ])('rejects %s with 400', async (_name, body) => {
    await expectError(await patch(body), 400, 'validation_failed')
  })
})

describe('DELETE /v1/vehicles/:id', () => {
  const remove = (sub?: string) =>
    h.authed(`/v1/vehicles/${VEHICLE_ID}`, { method: 'DELETE' }, sub)

  it('soft-deletes the documents first, then the vehicle, and rebuilds reminders', async () => {
    const deletedAt = '2026-10-20T06:00:00.000Z'
    h.supabase((call) => {
      if (table(call) === 'documents') {
        return Response.json([doc({ deleted_at: deletedAt }), doc({ id: VEHICLE_ID, deleted_at: deletedAt })])
      }
      return Response.json([{ id: VEHICLE_ID }])
    })
    const res = await remove()
    expect(res.status).toBe(204)
    expect(h.calls.map((c) => [c.method, table(c)])).toEqual([
      ['GET', 'vehicles'],
      ['PATCH', 'documents'],
      ['PATCH', 'vehicles'],
    ])
    expect(h.calls[1]?.url.searchParams.get('vehicle_id')).toBe(`eq.${VEHICLE_ID}`)
    expect(h.calls[1]?.body).toEqual({ deleted_at: deletedAt })
    expect(h.calls[2]?.body).toEqual({ deleted_at: deletedAt })
    expect(rebuildReminders).toHaveBeenCalledTimes(2)
  })

  it("returns 404 for user B on user A's vehicle without touching documents", async () => {
    h.supabase(() => Response.json([]))
    await expectError(await remove(USER_B), 404, 'not_found')
    expect(h.calls).toHaveLength(1)
  })
})

describe('POST /v1/vehicles/:id/documents', () => {
  const create = (body: unknown, sub?: string, vehicleId = VEHICLE_ID) =>
    h.authed(`/v1/vehicles/${vehicleId}/documents`, { method: 'POST', ...json(body) }, sub)
  const valid = { id: DOC_ID, type: 'insurance', expiryDate: '2026-10-25' }

  const stub = (opts: { vehicle?: boolean; inserted?: boolean; updated?: boolean } = {}) =>
    h.supabase((call) => {
      const t = table(call)
      if (t === 'vehicles') return Response.json(opts.vehicle === false ? [] : [{ id: VEHICLE_ID }])
      if (t === 'profiles') return Response.json([{ default_reminder_days: [14, 3] }])
      if (call.method === 'POST') return Response.json(opts.inserted === false ? [] : [doc()])
      return Response.json(opts.updated === false ? [] : [doc()])
    })

  it('creates with profile default reminder days, returns 201 and rebuilds reminders', async () => {
    stub()
    const res = await create(valid)
    expect(res.status).toBe(201)
    const body = await res.json<Record<string, unknown>>()
    expect(body).toMatchObject({ id: DOC_ID, vehicleId: VEHICLE_ID, status: 'expiring_soon', daysLeft: 5 })
    expectCamelCase(body)
    const insert = h.calls.find((c) => table(c) === 'documents')
    expect(insert?.body).toEqual({
      id: DOC_ID,
      user_id: USER_A,
      vehicle_id: VEHICLE_ID,
      type: 'insurance',
      custom_name: null,
      expiry_date: '2026-10-25',
      reminder_days: [14, 3],
      push_enabled: true,
      email_enabled: true,
    })
    expect(rebuildReminders).toHaveBeenCalledTimes(1)
  })

  it('skips the profile when reminderDays is given', async () => {
    stub()
    await create({ ...valid, reminderDays: [10] })
    expect(h.calls.some((c) => table(c) === 'profiles')).toBe(false)
  })

  it('updates the existing live row and returns 200', async () => {
    stub({ inserted: false })
    const res = await create(valid)
    expect(res.status).toBe(200)
    const update = h.calls.find((c) => table(c) === 'documents' && c.method === 'PATCH')
    expect(update?.url.searchParams.get('vehicle_id')).toBe(`eq.${VEHICLE_ID}`)
    expect(rebuildReminders).toHaveBeenCalledTimes(1)
  })

  it('returns 409 when the document id is taken', async () => {
    stub({ inserted: false, updated: false })
    await expectError(await create(valid), 409, 'conflict')
    expect(rebuildReminders).not.toHaveBeenCalled()
  })

  it('returns 404 for a foreign or deleted vehicle', async () => {
    stub({ vehicle: false })
    await expectError(await create(valid, USER_B), 404, 'not_found')
    expect(h.calls.some((c) => table(c) === 'documents')).toBe(false)
  })

  it.each([
    ['custom without customName', { ...valid, type: 'custom' }],
    ['customName on a non-custom type', { ...valid, customName: 'Permit' }],
    ['an unknown field', { ...valid, vehicleId: VEHICLE_ID }],
    ['a bad date', { ...valid, expiryDate: '2026-02-30' }],
    ['too many reminder days', { ...valid, reminderDays: [1, 2, 3, 4, 5, 6, 7] }],
    ['an out-of-range reminder day', { ...valid, reminderDays: [366] }],
  ])('rejects %s with 400', async (_name, body) => {
    await expectError(await create(body), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects a bad vehicle UUID with 400', async () => {
    await expectError(await create(valid, USER_A, 'nope'), 400, 'validation_failed')
  })
})
