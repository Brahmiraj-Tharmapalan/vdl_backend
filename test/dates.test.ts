import { describe, expect, it } from 'vitest'
import {
  addDays,
  daysBetween,
  formatDisplayDate,
  isValidIsoDate,
  todayInColombo,
} from '../src/lib/dates'

describe('todayInColombo', () => {
  it('uses Colombo midnight (18:30 UTC), not UTC midnight', () => {
    expect(todayInColombo(new Date('2026-10-19T18:29:59Z'))).toBe('2026-10-19')
    expect(todayInColombo(new Date('2026-10-19T18:30:00Z'))).toBe('2026-10-20')
    expect(todayInColombo(new Date('2026-10-19T18:31:00Z'))).toBe('2026-10-20')
  })

  it('is a day ahead of UTC late in the UTC day', () => {
    expect(todayInColombo(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01')
  })

  it('matches UTC early in the UTC day', () => {
    expect(todayInColombo(new Date('2026-10-19T00:00:00Z'))).toBe('2026-10-19')
  })
})

describe('isValidIsoDate', () => {
  it.each(['2026-10-19', '2028-02-29', '2026-12-31', '2026-01-01'])('accepts %s', (d) => {
    expect(isValidIsoDate(d)).toBe(true)
  })

  it.each([
    '2026-02-29',
    '2100-02-29',
    '2026-13-01',
    '2026-04-31',
    '2026-00-10',
    '2026-1-01',
    '2026-10-19T00:00:00Z',
    '',
    'abc',
  ])('rejects %s', (d) => {
    expect(isValidIsoDate(d)).toBe(false)
  })
})

describe('addDays', () => {
  it('crosses month ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01')
  })

  it('crosses year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('handles zero and large offsets', () => {
    expect(addDays('2026-10-19', 0)).toBe('2026-10-19')
    expect(addDays('2026-10-19', 365)).toBe('2027-10-19')
    expect(addDays('2026-10-24', -30)).toBe('2026-09-24')
  })

  it('throws on invalid dates', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow()
  })
})

describe('daysBetween', () => {
  it('counts whole days, signed', () => {
    expect(daysBetween('2026-10-19', '2026-10-19')).toBe(0)
    expect(daysBetween('2026-10-19', '2026-10-24')).toBe(5)
    expect(daysBetween('2026-10-24', '2026-10-19')).toBe(-5)
  })

  it('works across months, leap years and years', () => {
    expect(daysBetween('2026-01-31', '2026-03-01')).toBe(29)
    expect(daysBetween('2028-01-31', '2028-03-01')).toBe(30)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365)
    expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366)
  })
})

describe('formatDisplayDate', () => {
  it('formats as D Mon YYYY', () => {
    expect(formatDisplayDate('2026-10-24')).toBe('24 Oct 2026')
    expect(formatDisplayDate('2027-01-05')).toBe('5 Jan 2027')
    expect(formatDisplayDate('2028-02-29')).toBe('29 Feb 2028')
  })
})
