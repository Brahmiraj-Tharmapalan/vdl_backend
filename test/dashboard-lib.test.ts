import { describe, expect, it } from 'vitest'
import {
  buildDashboard,
  toUpcomingReminders,
  type DashboardVehicle,
  type UpcomingReminderRow,
} from '../src/lib/dashboard'
import type { Tables } from '../src/types/db'

const TODAY = '2026-10-20'
const V1 = '44444444-4444-4444-8444-444444444441'
const V2 = '44444444-4444-4444-8444-444444444442'

const vehicle = (over: Partial<DashboardVehicle> = {}): DashboardVehicle => ({
  id: V1,
  nickname: 'Car',
  plate_number: 'CAB-1234',
  type: 'car',
  deleted_at: null,
  ...over,
})

let n = 0
const doc = (over: Partial<Tables<'documents'>> = {}): Tables<'documents'> => {
  n += 1
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    user_id: '11111111-1111-4111-8111-111111111111',
    vehicle_id: V1,
    type: 'insurance',
    custom_name: null,
    expiry_date: '2027-01-01',
    reminder_days: [30, 7, 1],
    push_enabled: true,
    email_enabled: true,
    created_at: '2026-10-19T00:00:00+00:00',
    updated_at: '2026-10-20T00:00:00+00:00',
    client_updated_at: '2026-10-20T00:00:00+00:00',
    deleted_at: null,
    ...over,
  }
}

describe('buildDashboard counts', () => {
  it('is all zeros for an empty account', () => {
    expect(buildDashboard([], [], TODAY)).toEqual({
      counts: { vehicles: 0, documents: 0, toRenew: 0 },
      upcoming: [],
    })
  })

  it('counts toRenew at the status boundaries (Colombo today)', () => {
    const docs = [
      doc({ expiry_date: '2026-10-19' }), // -1 expired
      doc({ expiry_date: '2026-10-20' }), // 0 expiring_soon
      doc({ expiry_date: '2026-11-19' }), // 30 expiring_soon
      doc({ expiry_date: '2026-11-20' }), // 31 valid
    ]
    expect(buildDashboard([vehicle()], docs, TODAY).counts).toEqual({
      vehicles: 1,
      documents: 4,
      toRenew: 3,
    })
  })

  it('excludes soft-deleted vehicles and documents, and documents on deleted vehicles', () => {
    const vehicles = [vehicle(), vehicle({ id: V2, deleted_at: '2026-10-20T00:00:00Z' })]
    const docs = [
      doc({ expiry_date: '2026-10-01' }),
      doc({ expiry_date: '2026-10-01', deleted_at: '2026-10-20T00:00:00Z' }),
      doc({ expiry_date: '2026-10-01', vehicle_id: V2 }),
      doc({ expiry_date: '2026-10-01', vehicle_id: '44444444-4444-4444-8444-444444444449' }),
    ]
    const result = buildDashboard(vehicles, docs, TODAY)
    expect(result.counts).toEqual({ vehicles: 1, documents: 1, toRenew: 1 })
    expect(result.upcoming.map((d) => d.id)).toEqual([docs[0]?.id])
  })
})

describe('buildDashboard upcoming', () => {
  it('returns the 5 soonest expiries, expired first, with the vehicle summary', () => {
    const docs = [
      doc({ expiry_date: '2027-06-01' }),
      doc({ expiry_date: '2026-11-01' }),
      doc({ expiry_date: '2026-09-01' }), // most overdue
      doc({ expiry_date: '2026-10-19' }),
      doc({ expiry_date: '2028-01-01' }),
      doc({ expiry_date: '2026-10-20' }),
      doc({ expiry_date: '2027-01-01' }),
    ]
    const { upcoming } = buildDashboard([vehicle()], docs, TODAY)
    expect(upcoming.map((d) => d.expiryDate)).toEqual([
      '2026-09-01',
      '2026-10-19',
      '2026-10-20',
      '2026-11-01',
      '2027-01-01',
    ])
    expect(upcoming.map((d) => d.status)).toEqual([
      'expired',
      'expired',
      'expiring_soon',
      'expiring_soon',
      'valid',
    ])
    expect(upcoming[0]?.vehicle).toEqual({ nickname: 'Car', plateNumber: 'CAB-1234', type: 'car' })
    expect(upcoming[0]).not.toHaveProperty('userId')
  })

  it('breaks expiry ties by created_at, then id', () => {
    const a = doc({ id: '00000000-0000-4000-8000-00000000000b', created_at: '2026-10-02T00:00:00Z' })
    const b = doc({ id: '00000000-0000-4000-8000-00000000000a', created_at: '2026-10-02T00:00:00Z' })
    const c = doc({ id: '00000000-0000-4000-8000-000000000000', created_at: '2026-10-03T00:00:00Z' })
    const d = doc({ id: '00000000-0000-4000-8000-00000000000f', created_at: '2026-10-01T00:00:00Z' })
    const { upcoming } = buildDashboard([vehicle()], [a, b, c, d], TODAY)
    expect(upcoming.map((x) => x.id)).toEqual([d.id, b.id, a.id, c.id])
  })

  it('returns fewer than 5 when there are fewer documents', () => {
    expect(buildDashboard([vehicle()], [doc(), doc()], TODAY).upcoming).toHaveLength(2)
  })
})

describe('toUpcomingReminders', () => {
  const row = (
    over: Partial<UpcomingReminderRow> = {},
    docDeleted: string | null = null,
    vehicleDeleted: string | null = null,
  ): UpcomingReminderRow => ({
    id: '66666666-6666-4666-8666-666666666666',
    user_id: '11111111-1111-4111-8111-111111111111',
    document_id: '55555555-5555-4555-8555-555555555555',
    days_before: 7,
    send_on: '2026-10-25',
    channel: 'push',
    status: 'scheduled',
    sent_at: null,
    error: null,
    created_at: '2026-10-19T00:00:00+00:00',
    updated_at: '2026-10-20T00:00:00+00:00',
    documents: {
      type: 'custom',
      custom_name: 'Permit',
      expiry_date: '2026-11-01',
      deleted_at: docDeleted,
      vehicles: { nickname: 'Bike', plate_number: 'BAA-1', type: 'motorbike', deleted_at: vehicleDeleted },
    },
    ...over,
  })

  it('maps to camelCase with document and vehicle summaries', () => {
    const [item] = toUpcomingReminders([row()])
    expect(item).toEqual({
      id: '66666666-6666-4666-8666-666666666666',
      documentId: '55555555-5555-4555-8555-555555555555',
      daysBefore: 7,
      sendOn: '2026-10-25',
      channel: 'push',
      status: 'scheduled',
      sentAt: null,
      document: { type: 'custom', customName: 'Permit', expiryDate: '2026-11-01' },
      vehicle: { nickname: 'Bike', plateNumber: 'BAA-1', type: 'motorbike' },
    })
  })

  it('drops reminders whose document or vehicle is deleted', () => {
    const deleted = '2026-10-20T00:00:00Z'
    expect(toUpcomingReminders([row({}, deleted), row({}, null, deleted)])).toEqual([])
  })
})
