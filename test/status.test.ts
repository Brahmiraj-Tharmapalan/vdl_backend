import { describe, expect, it } from 'vitest'
import { computeStatus, isToRenew } from '../src/lib/status'

const today = '2026-10-19'

describe('computeStatus', () => {
  it('expired when expiry is before today', () => {
    expect(computeStatus('2026-10-18', today)).toBe('expired')
    expect(computeStatus('2025-01-01', today)).toBe('expired')
  })

  it('expiring_soon from today up to +30 days', () => {
    expect(computeStatus('2026-10-19', today)).toBe('expiring_soon')
    expect(computeStatus('2026-10-20', today)).toBe('expiring_soon')
    expect(computeStatus('2026-11-18', today)).toBe('expiring_soon') // +30
  })

  it('valid from +31 days', () => {
    expect(computeStatus('2026-11-19', today)).toBe('valid') // +31
    expect(computeStatus('2027-10-19', today)).toBe('valid')
  })

  it('counts across a leap February', () => {
    // 2028-02-01 + 30 = 2028-03-02
    expect(computeStatus('2028-03-02', '2028-02-01')).toBe('expiring_soon')
    expect(computeStatus('2028-03-03', '2028-02-01')).toBe('valid')
  })
})

describe('isToRenew', () => {
  it('is true for expired and expiring_soon only', () => {
    expect(isToRenew('expired')).toBe(true)
    expect(isToRenew('expiring_soon')).toBe(true)
    expect(isToRenew('valid')).toBe(false)
  })
})
