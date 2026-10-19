import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  customName,
  documentType,
  idParam,
  isoDate,
  nickname,
  plate,
  reminderDays,
  uuid,
  vehicleType,
} from '../src/schemas/common'

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success

describe('uuid', () => {
  it('accepts a v4 UUID and rejects junk', () => {
    expect(ok(uuid, '0b6c8d4e-3f2a-4c1b-9d8e-7f6a5b4c3d2e')).toBe(true)
    expect(ok(uuid, 'not-a-uuid')).toBe(false)
    expect(ok(uuid, '0b6c8d4e3f2a4c1b9d8e7f6a5b4c3d2e')).toBe(false)
    expect(ok(uuid, 123)).toBe(false)
  })
})

describe('isoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(ok(isoDate, '2026-10-24')).toBe(true)
    expect(ok(isoDate, '2028-02-29')).toBe(true)
    expect(ok(isoDate, '2026-02-29')).toBe(false)
    expect(ok(isoDate, '2026-10-24T00:00:00Z')).toBe(false)
    expect(ok(isoDate, '24/10/2026')).toBe(false)
  })
})

describe('plate', () => {
  it('trims and uppercases', () => {
    expect(plate.parse(' cab-1234 ')).toBe('CAB-1234')
    expect(plate.parse('wp cab 1234')).toBe('WP CAB 1234')
  })

  it('rejects bad characters, empty and too long', () => {
    expect(ok(plate, 'CAB_1234')).toBe(false)
    expect(ok(plate, 'CAB/1234')).toBe(false)
    expect(ok(plate, '   ')).toBe(false)
    expect(ok(plate, 'A'.repeat(15))).toBe(true)
    expect(ok(plate, 'A'.repeat(16))).toBe(false)
  })
})

describe('nickname / customName', () => {
  it.each([nickname, customName])('trims, requires 1..50 chars', (schema) => {
    expect(schema.parse('  My car  ')).toBe('My car')
    expect(ok(schema, '   ')).toBe(false)
    expect(ok(schema, 'a'.repeat(50))).toBe(true)
    expect(ok(schema, 'a'.repeat(51))).toBe(false)
  })
})

describe('reminderDays', () => {
  it('accepts up to 6 unique ints in 1..365', () => {
    expect(ok(reminderDays, [])).toBe(true)
    expect(ok(reminderDays, [30, 7, 1])).toBe(true)
    expect(ok(reminderDays, [1, 2, 3, 4, 5, 365])).toBe(true)
  })

  it('rejects out of range, duplicates, decimals and too many', () => {
    expect(ok(reminderDays, [0])).toBe(false)
    expect(ok(reminderDays, [366])).toBe(false)
    expect(ok(reminderDays, [7, 7])).toBe(false)
    expect(ok(reminderDays, [1.5])).toBe(false)
    expect(ok(reminderDays, [1, 2, 3, 4, 5, 6, 7])).toBe(false)
  })
})

describe('enums', () => {
  it('match the DB check constraints', () => {
    expect(vehicleType.options).toEqual(['car', 'motorbike', 'three_wheeler', 'van'])
    expect(documentType.options).toEqual([
      'revenue_licence',
      'insurance',
      'emission_test',
      'registration',
      'custom',
    ])
    expect(ok(vehicleType, 'truck')).toBe(false)
  })
})

describe('idParam', () => {
  it('is strict and needs a UUID', () => {
    expect(ok(idParam, { id: '0b6c8d4e-3f2a-4c1b-9d8e-7f6a5b4c3d2e' })).toBe(true)
    expect(ok(idParam, { id: '1' })).toBe(false)
    expect(ok(idParam, { id: '0b6c8d4e-3f2a-4c1b-9d8e-7f6a5b4c3d2e', extra: 1 })).toBe(false)
  })
})
