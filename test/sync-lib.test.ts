import { describe, expect, it } from 'vitest'
import {
  isTooFarInFuture,
  MAX_FUTURE_SKEW_MS,
  parseSyncResult,
  shouldApply,
  toSyncParams,
  toSyncResponse,
} from '../src/lib/sync'
import { syncBody } from '../src/schemas/sync'

const VEHICLE_ID = '44444444-4444-4444-8444-444444444444'

describe('shouldApply (mirror of the sync_changes merge rule)', () => {
  const server = (client_updated_at: string, deleted_at: string | null = null) => ({
    client_updated_at,
    deleted_at,
  })
  const live = (updatedAt: string) => ({ updatedAt, deletedAt: null })

  it('applies a row the server does not have', () => {
    expect(shouldApply(null, live('2026-10-01T00:00:00Z'))).toBe(true)
  })

  it('ignores an older row', () => {
    expect(shouldApply(server('2026-10-10T00:00:00Z'), live('2026-10-09T23:59:59Z'))).toBe(false)
  })

  it('ignores an equal timestamp', () => {
    expect(shouldApply(server('2026-10-10T00:00:00+00:00'), live('2026-10-10T05:30:00+05:30'))).toBe(false)
  })

  it('applies a newer row', () => {
    expect(shouldApply(server('2026-10-10T00:00:00Z'), live('2026-10-10T00:00:00.001Z'))).toBe(true)
  })

  it('applies a delete even when it is older', () => {
    const del = { updatedAt: '2026-10-01T00:00:00Z', deletedAt: '2026-10-01T00:00:00Z' }
    expect(shouldApply(server('2026-10-10T00:00:00Z'), del)).toBe(true)
  })

  it('never changes a row already deleted on the server', () => {
    const deleted = server('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')
    expect(shouldApply(deleted, live('2026-10-20T00:00:00Z'))).toBe(false)
  })
})

describe('isTooFarInFuture', () => {
  const now = new Date('2026-10-20T00:00:00Z')
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString()

  it('allows exactly 5 minutes ahead', () => {
    expect(isTooFarInFuture(at(MAX_FUTURE_SKEW_MS), now)).toBe(false)
  })

  it('rejects anything beyond 5 minutes', () => {
    expect(isTooFarInFuture(at(MAX_FUTURE_SKEW_MS + 1), now)).toBe(true)
  })

  it('allows the past', () => {
    expect(isTooFarInFuture('2020-01-01T00:00:00Z', now)).toBe(false)
  })
})

describe('syncBody', () => {
  it('defaults missing arrays to empty and accepts a returned serverTime as lastSyncedAt', () => {
    const parsed = syncBody.parse({ lastSyncedAt: '2026-10-20T05:59:00.123Z', changes: {} })
    expect(parsed.changes).toEqual({ vehicles: [], documents: [] })
  })

  it('accepts an offset timestamp', () => {
    expect(syncBody.safeParse({ lastSyncedAt: '2026-10-20T11:29:00+05:30', changes: {} }).success).toBe(true)
  })
})

describe('toSyncParams', () => {
  it('maps a vehicle with omitted optional fields to nulls', () => {
    const body = syncBody.parse({
      lastSyncedAt: null,
      changes: {
        vehicles: [{ id: VEHICLE_ID, plateNumber: ' cab-1 ', type: 'van', updatedAt: '2026-10-01T00:00:00Z' }],
      },
    })
    expect(toSyncParams(body)).toEqual({
      p_vehicles: [
        {
          id: VEHICLE_ID,
          nickname: null,
          plate_number: 'CAB-1',
          type: 'van',
          updated_at: '2026-10-01T00:00:00Z',
          deleted_at: null,
        },
      ],
      p_documents: [],
    })
  })
})

describe('parseSyncResult / toSyncResponse', () => {
  it('rejects a malformed result without leaking values', () => {
    expect(() => parseSyncResult({ server_time: 'x', rejected: [], vehicles: [{ plate_number: 'CAB-1' }], documents: [] }))
      .toThrow('Unexpected sync_changes result shape')
  })

  it('rounds serverTime down to milliseconds', () => {
    const res = toSyncResponse(
      parseSyncResult({ server_time: '2026-10-20T05:59:00.999999+00:00', rejected: [], vehicles: [], documents: [] }),
      '2026-10-20',
    )
    expect(res).toEqual({ serverTime: '2026-10-20T05:59:00.999Z', vehicles: [], documents: [], rejected: [] })
  })
})
