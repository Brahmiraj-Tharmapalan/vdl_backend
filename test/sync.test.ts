import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncResult } from '../src/lib/sync'
import type { Tables } from '../src/types/db'
import {
  expectCamelCase,
  expectError,
  json,
  setupHarness,
  USER_A,
  type Harness,
  type SupabaseCall,
} from './helpers/api'

const NOW = new Date('2026-10-20T06:00:00.000Z')
const VEHICLE_ID = '44444444-4444-4444-8444-444444444444'
const DOC_ID = '55555555-5555-4555-8555-555555555555'
const FOREIGN_ID = '66666666-6666-4666-8666-666666666666'

const vehicleRow = (over: Partial<Tables<'vehicles'>> = {}): Tables<'vehicles'> => ({
  id: VEHICLE_ID,
  user_id: USER_A,
  nickname: 'Family car',
  plate_number: 'CAB-1234',
  type: 'car',
  client_updated_at: '2026-10-20T05:00:00+00:00',
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T06:00:00.123456+00:00',
  deleted_at: null,
  ...over,
})

const documentRow = (over: Partial<Tables<'documents'>> = {}): Tables<'documents'> => ({
  id: DOC_ID,
  user_id: USER_A,
  vehicle_id: VEHICLE_ID,
  type: 'insurance',
  custom_name: null,
  expiry_date: '2026-10-25',
  reminder_days: [30, 7, 1],
  push_enabled: true,
  email_enabled: true,
  client_updated_at: '2026-10-20T05:00:00+00:00',
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T06:00:00.123456+00:00',
  deleted_at: null,
  ...over,
})

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  server_time: '2026-10-20T05:59:00.123456+00:00',
  rejected: [],
  vehicles: [],
  documents: [],
  ...over,
})

const vehicleChange = (over: Record<string, unknown> = {}) => ({
  id: VEHICLE_ID,
  nickname: 'Family car',
  plateNumber: 'cab-1234',
  type: 'car',
  updatedAt: '2026-10-20T05:00:00Z',
  deletedAt: null,
  ...over,
})

const documentChange = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  vehicleId: VEHICLE_ID,
  type: 'insurance',
  expiryDate: '2026-10-25',
  reminderDays: [30, 7, 1],
  pushEnabled: true,
  emailEnabled: false,
  updatedAt: '2026-10-20T05:00:00Z',
  ...over,
})

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

let h: Harness

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h = await setupHarness()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const sync = (body: unknown) => h.authed('/v1/sync', { method: 'POST', ...json(body) })

/** Stubs the sync_changes RPC and returns its recorded calls. */
function stubRpc(res: SyncResult | Response = result()): SupabaseCall[] {
  h.supabase((call) => {
    expect(call.url.pathname).toBe('/rest/v1/rpc/sync_changes')
    return res instanceof Response ? res : Response.json(res)
  })
  return h.calls
}

const empty = { lastSyncedAt: null, changes: {} }

describe('POST /v1/sync auth and limits', () => {
  it('returns 401 without a token', async () => {
    const res = await h.call('/v1/sync', { method: 'POST', ...json(empty) })
    await expectError(res, 401, 'unauthorized')
  })

  it('uses the strict limiter keyed by user', async () => {
    stubRpc()
    await sync(empty)
    expect(h.strictLimit).toHaveBeenCalledWith({ key: USER_A })
  })

  it('returns 429 when over the strict limit', async () => {
    h.strictLimit.mockResolvedValue({ success: false })
    await expectError(await sync(empty), 429, 'rate_limited')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects a body over 1 MB with 413', async () => {
    const res = await h.authed('/v1/sync', { method: 'POST', ...json({ pad: 'x'.repeat(1024 * 1024) }) })
    await expectError(res, 413, 'payload_too_large')
  })
})

describe('POST /v1/sync push', () => {
  it('calls the RPC once with snake_case rows and never a user id', async () => {
    const calls = stubRpc()
    const res = await sync({
      lastSyncedAt: '2026-10-19T00:00:00Z',
      changes: {
        vehicles: [vehicleChange({ nickname: undefined })],
        documents: [documentChange({ deletedAt: '2026-10-20T05:00:00Z' })],
      },
    })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({
      p_last_synced_at: '2026-10-19T00:00:00Z',
      p_vehicles: [
        {
          id: VEHICLE_ID,
          nickname: null,
          plate_number: 'CAB-1234',
          type: 'car',
          updated_at: '2026-10-20T05:00:00Z',
          deleted_at: null,
        },
      ],
      p_documents: [
        {
          id: DOC_ID,
          vehicle_id: VEHICLE_ID,
          type: 'insurance',
          custom_name: null,
          expiry_date: '2026-10-25',
          reminder_days: [30, 7, 1],
          push_enabled: true,
          email_enabled: false,
          updated_at: '2026-10-20T05:00:00Z',
          deleted_at: '2026-10-20T05:00:00Z',
        },
      ],
    })
    expect(JSON.stringify(calls[0]?.body)).not.toContain(USER_A)
  })

  it('omits lastSyncedAt for a full pull (null)', async () => {
    const calls = stubRpc()
    await sync(empty)
    expect(calls[0]?.body).toEqual({ p_vehicles: [], p_documents: [] })
  })

  it('accepts 500 rows and an updatedAt 4 minutes ahead', async () => {
    stubRpc()
    const ahead = new Date(NOW.getTime() + 4 * 60_000).toISOString()
    const vehicles = ids(500).map((id) => vehicleChange({ id, updatedAt: ahead }))
    const res = await sync({ lastSyncedAt: null, changes: { vehicles } })
    expect(res.status).toBe(200)
  })
})

describe('POST /v1/sync validation', () => {
  const future = new Date(NOW.getTime() + 6 * 60_000).toISOString()

  it.each([
    ['an unknown top-level field', { ...empty, extra: 1 }],
    ['an unknown changes field', { lastSyncedAt: null, changes: { devices: [] } }],
    ['a missing lastSyncedAt', { changes: {} }],
    ['a bad lastSyncedAt', { lastSyncedAt: 'yesterday', changes: {} }],
    ['an unknown row field', { lastSyncedAt: null, changes: { vehicles: [vehicleChange({ userId: USER_A })] } }],
    ['a bad uuid', { lastSyncedAt: null, changes: { vehicles: [vehicleChange({ id: 'nope' })] } }],
    ['a bad vehicleId', { lastSyncedAt: null, changes: { documents: [documentChange({ vehicleId: 'nope' })] } }],
    ['more than 500 vehicles', { lastSyncedAt: null, changes: { vehicles: ids(501).map((id) => vehicleChange({ id })) } }],
    ['more than 500 documents', { lastSyncedAt: null, changes: { documents: ids(501).map((id) => documentChange({ id })) } }],
    ['an updatedAt over 5 min in the future', { lastSyncedAt: null, changes: { vehicles: [vehicleChange({ updatedAt: future })] } }],
    ['a deletedAt over 5 min in the future', { lastSyncedAt: null, changes: { documents: [documentChange({ deletedAt: future })] } }],
    ['duplicate ids', { lastSyncedAt: null, changes: { vehicles: [vehicleChange(), vehicleChange()] } }],
    ['a custom doc without customName', { lastSyncedAt: null, changes: { documents: [documentChange({ type: 'custom' })] } }],
    ['a customName on a non-custom doc', { lastSyncedAt: null, changes: { documents: [documentChange({ customName: 'X' })] } }],
    ['missing reminder settings', { lastSyncedAt: null, changes: { documents: [documentChange({ reminderDays: undefined })] } }],
    ['a bad plate', { lastSyncedAt: null, changes: { vehicles: [vehicleChange({ plateNumber: 'CAB_1' })] } }],
  ])('rejects %s with 400', async (_, body) => {
    const res = await sync(body)
    await expectError(res, 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })

  it('never echoes input values in details', async () => {
    const res = await sync({ lastSyncedAt: null, changes: { vehicles: [vehicleChange({ plateNumber: 'SECRET_1' })] } })
    expect(JSON.stringify(await res.json())).not.toContain('SECRET')
  })
})

describe('POST /v1/sync response', () => {
  it('maps rows, keeps soft deletes, passes rejections and normalizes serverTime', async () => {
    stubRpc(
      result({
        vehicles: [vehicleRow({ deleted_at: '2026-10-20T05:30:00+00:00' })],
        documents: [
          documentRow(),
          documentRow({ id: FOREIGN_ID, expiry_date: '2026-10-01', deleted_at: '2026-10-20T05:30:00+00:00' }),
        ],
        rejected: [
          { entity: 'vehicle', id: FOREIGN_ID, reason: 'id_in_use' },
          { entity: 'document', id: DOC_ID, reason: 'vehicle_not_found' },
        ],
      }),
    )
    const res = await sync(empty)
    expect(res.status).toBe(200)
    const body = await res.json<{
      serverTime: string
      vehicles: Record<string, unknown>[]
      documents: Record<string, unknown>[]
      rejected: unknown[]
    }>()

    expect(body.serverTime).toBe('2026-10-20T05:59:00.123Z')
    expect(body.vehicles).toEqual([
      {
        id: VEHICLE_ID,
        nickname: 'Family car',
        plateNumber: 'CAB-1234',
        type: 'car',
        createdAt: '2026-10-19T00:00:00+00:00',
        updatedAt: '2026-10-20T06:00:00.123456+00:00',
        deletedAt: '2026-10-20T05:30:00+00:00',
      },
    ])
    expect(body.documents[0]).toMatchObject({ id: DOC_ID, status: 'expiring_soon', daysLeft: 5, deletedAt: null })
    expect(body.documents[1]).toMatchObject({ id: FOREIGN_ID, status: 'expired', deletedAt: '2026-10-20T05:30:00+00:00' })
    expect(body.rejected).toEqual([
      { entity: 'vehicle', id: FOREIGN_ID, reason: 'id_in_use' },
      { entity: 'document', id: DOC_ID, reason: 'vehicle_not_found' },
    ])
    for (const row of [...body.vehicles, ...body.documents]) {
      expectCamelCase(row)
      expect(row).not.toHaveProperty('userId')
      expect(row).not.toHaveProperty('clientUpdatedAt')
    }
  })

  it('returns a generic 500 when the RPC fails', async () => {
    stubRpc(Response.json({ code: 'XX000', message: 'secret SQL detail' }, { status: 500 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await sync(empty)
    const body = await expectError(res, 500, 'internal_error')
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('returns a generic 500 for a malformed RPC result', async () => {
    stubRpc(Response.json({ server_time: 'x', vehicles: [{ id: 1 }] }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expectError(await sync(empty), 500, 'internal_error')
  })
})
