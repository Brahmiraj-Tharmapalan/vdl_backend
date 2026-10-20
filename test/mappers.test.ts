import { describe, expect, it } from 'vitest'
import { toDevice, toDocument, toProfile, toReminder, toVehicle } from '../src/lib/mappers'
import type { Tables } from '../src/types/db'

const USER = '11111111-1111-4111-8111-111111111111'
const TS = '2026-10-19T10:00:00+00:00'

const documentRow: Tables<'documents'> = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: USER,
  vehicle_id: '33333333-3333-4333-8333-333333333333',
  type: 'insurance',
  custom_name: null,
  expiry_date: '2026-10-24',
  reminder_days: [30, 7, 1],
  push_enabled: true,
  email_enabled: false,
  created_at: TS,
  updated_at: TS,
  client_updated_at: TS,
  deleted_at: null,
}

describe('mappers', () => {
  it('maps a document with computed status and no user_id', () => {
    const dto = toDocument(documentRow, '2026-10-19')
    expect(dto).toEqual({
      id: documentRow.id,
      vehicleId: documentRow.vehicle_id,
      type: 'insurance',
      customName: null,
      expiryDate: '2026-10-24',
      reminderDays: [30, 7, 1],
      pushEnabled: true,
      emailEnabled: false,
      status: 'expiring_soon',
      daysLeft: 5,
      createdAt: TS,
      updatedAt: TS,
      deletedAt: null,
    })
    expect(toDocument(documentRow, '2026-10-25').status).toBe('expired')
  })

  it('maps a vehicle', () => {
    const dto = toVehicle({
      id: documentRow.vehicle_id,
      user_id: USER,
      nickname: 'Family car',
      plate_number: 'CAB-1234',
      type: 'car',
      created_at: TS,
      updated_at: TS,
      client_updated_at: TS,
      deleted_at: null,
    })
    expect(dto).toEqual({
      id: documentRow.vehicle_id,
      nickname: 'Family car',
      plateNumber: 'CAB-1234',
      type: 'car',
      createdAt: TS,
      updatedAt: TS,
      deletedAt: null,
    })
  })

  it('maps a profile', () => {
    const dto = toProfile({
      id: USER,
      display_name: 'A',
      reminder_email: 'a@example.com',
      push_enabled: true,
      email_enabled: true,
      default_reminder_days: [30, 7, 1],
      theme: 'dark',
      last_synced_at: null,
      created_at: TS,
      updated_at: TS,
    })
    expect(dto).toEqual({
      displayName: 'A',
      reminderEmail: 'a@example.com',
      pushEnabled: true,
      emailEnabled: true,
      defaultReminderDays: [30, 7, 1],
      theme: 'dark',
      lastSyncedAt: null,
      updatedAt: TS,
    })
  })

  it('maps a reminder without the internal error text', () => {
    const dto = toReminder({
      id: '44444444-4444-4444-8444-444444444444',
      user_id: USER,
      document_id: documentRow.id,
      days_before: 7,
      send_on: '2026-10-17',
      channel: 'push',
      status: 'failed',
      sent_at: null,
      error: 'Expo said no',
      created_at: TS,
      updated_at: TS,
    })
    expect(dto).not.toHaveProperty('error')
    expect(dto).not.toHaveProperty('userId')
    expect(dto).toMatchObject({ daysBefore: 7, sendOn: '2026-10-17', channel: 'push', status: 'failed' })
  })

  it('maps a device without the push token', () => {
    const dto = toDevice({
      id: '55555555-5555-4555-8555-555555555555',
      user_id: USER,
      push_token: 'ExponentPushToken[xyz]',
      platform: 'android',
      device_name: 'Pixel',
      last_seen_at: TS,
      created_at: TS,
      updated_at: TS,
    })
    expect(JSON.stringify(dto)).not.toContain('ExponentPushToken')
    expect(dto).toEqual({
      id: '55555555-5555-4555-8555-555555555555',
      platform: 'android',
      deviceName: 'Pixel',
      lastSeenAt: TS,
      createdAt: TS,
    })
  })

  it('throws on an unexpected enum value from the DB', () => {
    expect(() => toDocument({ ...documentRow, type: 'passport' }, '2026-10-19')).toThrow()
  })
})
