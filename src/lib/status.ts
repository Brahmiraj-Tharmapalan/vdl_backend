import { daysBetween, type IsoDate } from './dates'

export const EXPIRING_SOON_DAYS = 30

export type DocumentStatus = 'expired' | 'expiring_soon' | 'valid'

/**
 * Status is computed, never stored.
 * daysLeft = expiry - today: < 0 expired; 0..30 expiring_soon (expiry today is still valid
 * today, so it is expiring_soon); > 30 valid.
 */
export function computeStatus(expiryDate: IsoDate, today: IsoDate): DocumentStatus {
  const daysLeft = daysBetween(today, expiryDate)
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= EXPIRING_SOON_DAYS) return 'expiring_soon'
  return 'valid'
}

/** "To renew" = expired + expiring soon. */
export function isToRenew(status: DocumentStatus): boolean {
  return status !== 'valid'
}
