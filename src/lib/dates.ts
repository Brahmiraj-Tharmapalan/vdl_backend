// Calendar dates as `YYYY-MM-DD` strings. "Today" is Asia/Colombo (UTC+5:30, no DST).

export type IsoDate = string

const COLOMBO_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Milliseconds at UTC midnight of `date`, or null if it isn't a real calendar date. */
function toUtcMs(date: string): number | null {
  const m = ISO_DATE_RE.exec(date)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null
  }
  return ms
}

function parse(date: IsoDate): number {
  const ms = toUtcMs(date)
  if (ms === null) throw new Error('Invalid ISO date')
  return ms
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10)
}

export function isValidIsoDate(value: string): boolean {
  return toUtcMs(value) !== null
}

/** Today's date in Asia/Colombo. Pass `now` in tests. */
export function todayInColombo(now: Date = new Date()): IsoDate {
  return fromUtcMs(now.getTime() + COLOMBO_OFFSET_MS)
}

/** `date` plus `days` (negative subtracts). */
export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(parse(date) + days * DAY_MS)
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS)
}

/** `2026-10-24` → `24 Oct 2026`. */
export function formatDisplayDate(date: IsoDate): string {
  const d = new Date(parse(date))
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
