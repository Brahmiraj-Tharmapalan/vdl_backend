// Resend client and the daily reminder email: https://resend.com/docs/api-reference/emails
import type { EmailLine } from './reminder-message'

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails'
export const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch'
export const RESEND_BATCH_SIZE = 100

export type Email = { from: string; to: string; subject: string; html: string; text: string }

/** Short error code (`resend_<status>`); never the response text, which may contain the address. */
export type SendOutcome = { ok: true } | { ok: false; error: string; status: number | null }

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

const FOOTER =
  'You get this email because email reminders are on in Vehicle Doc Lanka. You can turn them off in the app settings.'

/** One email listing all of a user's due documents. Every piece of user text is escaped. */
export function renderReminderEmail(lines: readonly EmailLine[]): Omit<Email, 'from' | 'to'> {
  const n = lines.length
  const subject = `${n} ${n === 1 ? 'document needs' : 'documents need'} attention`
  const lineText = (l: EmailLine) => (l.nickname ? `${l.message} (${l.nickname})` : l.message)

  const items = lines.map((l) => `<li style="margin:0 0 8px">${escapeHtml(lineText(l))}</li>`)
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;line-height:1.5">',
    `<p>${escapeHtml(subject)}:</p>`,
    `<ul style="padding-left:20px">${items.join('')}</ul>`,
    '<p>Open the app to renew and update the expiry dates.</p>',
    `<p style="color:#666;font-size:12px">${escapeHtml(FOOTER)}</p>`,
    '</body></html>',
  ].join('')

  const text = [
    `${subject}:`,
    '',
    ...lines.map((l) => `- ${lineText(l)}`),
    '',
    'Open the app to renew and update the expiry dates.',
    '',
    FOOTER,
  ].join('\n')

  return { subject, html, text }
}

async function post(url: string, apiKey: string, body: unknown): Promise<SendOutcome> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, error: 'resend_network', status: null }
  }
  // Drain the body so the connection is released; its content is never logged or stored.
  await res.text().catch(() => '')
  return res.ok ? { ok: true } : { ok: false, error: `resend_${res.status}`, status: res.status }
}

export function sendEmail(email: Email, apiKey: string): Promise<SendOutcome> {
  return post(RESEND_EMAILS_URL, apiKey, email)
}

/** Sends ≤ 100 emails in one request. Resend validates the batch as a whole: all or nothing. */
export function sendEmailBatch(emails: readonly Email[], apiKey: string): Promise<SendOutcome> {
  return post(RESEND_BATCH_URL, apiKey, emails)
}

/** A rejected batch is retried one email at a time only for request errors (one bad email). */
export function shouldRetryIndividually(outcome: SendOutcome): boolean {
  return !outcome.ok && (outcome.status === 400 || outcome.status === 422)
}
