import { describe, expect, it } from 'vitest'
import {
  documentLabel,
  expiryPhrase,
  parseDueReminders,
  planDelivery,
  reminderMessage,
  toFinishPayload,
} from '../src/lib/reminder-message'
import { reminder } from './helpers/cron'

const TODAY = '2026-10-20'
const strip = ({ status: _s, error: _e, sent_at: _t, ...row }: ReturnType<typeof reminder>) => row

describe('reminderMessage', () => {
  it('matches the documented format', () => {
    const row = { doc_type: 'insurance', custom_name: null, plate_number: 'CAB-1234', expiry_date: '2026-10-25' }
    expect(reminderMessage(row, TODAY)).toBe('Insurance · CAB-1234 expires in 5 days (25 Oct 2026)')
  })

  it.each([
    ['2026-10-21', 'expires in 1 day'],
    ['2026-10-22', 'expires in 2 days'],
    ['2026-10-20', 'expires today'],
    ['2026-10-19', 'expired'],
  ])('expiry %s → %s', (expiry, phrase) => {
    expect(expiryPhrase(expiry, TODAY)).toBe(phrase)
  })

  it('labels every document type and uses customName for custom', () => {
    expect(documentLabel('revenue_licence', null)).toBe('Revenue licence')
    expect(documentLabel('emission_test', null)).toBe('Emission test')
    expect(documentLabel('registration', null)).toBe('Registration')
    expect(documentLabel('custom', 'Fitness cert')).toBe('Fitness cert')
    expect(documentLabel('custom', null)).toBe('Document')
  })
})

describe('planDelivery', () => {
  it('groups email rows into one email per user and push rows per reminder', () => {
    const rows = [
      reminder({ channel: 'push' }),
      reminder({ channel: 'email', nickname: 'Daily' }),
      reminder({ channel: 'email', user_id: '22222222-2222-4222-8222-222222222222', reminder_email: 'b@example.com' }),
    ].map(strip)
    const plan = planDelivery(rows, TODAY)
    expect(plan.results).toEqual([])
    expect(plan.push).toHaveLength(1)
    expect(plan.emails.map((e) => e.to)).toEqual(['a@example.com', 'b@example.com'])
    expect(plan.emails[0]?.lines[0]?.nickname).toBe('Daily')
  })

  it('isolates a user whose rows cannot be rendered', () => {
    const bad = strip(reminder({ expiry_date: 'not-a-date' }))
    const good = strip(reminder({ user_id: '22222222-2222-4222-8222-222222222222' }))
    const plan = planDelivery([bad, good], TODAY)
    expect(plan.results).toEqual([{ id: bad.id, status: 'failed', error: 'render_error' }])
    expect(plan.push.map((p) => p.reminderIds)).toEqual([[good.id]])
  })

  it('combines all of a user\'s push rows into one push, soonest expiry first', () => {
    const later = strip(reminder({ expiry_date: '2026-10-30' }))
    const sooner = strip(reminder({ doc_type: 'revenue_licence', expiry_date: '2026-10-21' }))
    const single = strip(reminder({ user_id: '22222222-2222-4222-8222-222222222222' }))
    const plan = planDelivery([later, sooner, single], TODAY)
    expect(plan.push).toEqual([
      {
        userId: later.user_id,
        reminderIds: [sooner.id, later.id],
        documentId: null,
        body: 'Revenue licence · CAB-1234 expires in 1 day (21 Oct 2026) and 1 more',
      },
      {
        userId: single.user_id,
        reminderIds: [single.id],
        documentId: single.document_id,
        body: 'Insurance · CAB-1234 expires in 5 days (25 Oct 2026)',
      },
    ])
  })
})

describe('parseDueReminders / toFinishPayload', () => {
  it('rejects an unexpected shape without echoing values', () => {
    expect(() => parseDueReminders([{ id: 'x', plate_number: 'SECRET-1' }])).toThrow(
      'Unexpected claim_due_reminders result shape',
    )
  })

  it('caps errors at 500 chars and omits missing errors', () => {
    expect(toFinishPayload([{ id: '1', status: 'sent' }, { id: '2', status: 'failed', error: 'x'.repeat(900) }])).toEqual([
      { id: '1', status: 'sent' },
      { id: '2', status: 'failed', error: 'x'.repeat(500) },
    ])
  })
})
