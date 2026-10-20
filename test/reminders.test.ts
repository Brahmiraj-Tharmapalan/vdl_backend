import { describe, expect, it } from 'vitest'
import { remindersChanged } from '../src/lib/reminders'
import type { Tables } from '../src/types/db'

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
