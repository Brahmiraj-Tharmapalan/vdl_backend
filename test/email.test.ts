import { afterEach, describe, expect, it, vi } from 'vitest'
import { escapeHtml, renderReminderEmail, sendEmail, shouldRetryIndividually } from '../src/lib/email'

afterEach(() => vi.restoreAllMocks())

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;',
    )
  })
})

describe('renderReminderEmail', () => {
  const lines = [
    { message: 'Insurance · <b>CAB-1234</b> expires in 5 days (25 Oct 2026)', nickname: `Mum's "car" & co` },
    { message: '<img src=x onerror=1> · AB-1 expires today (20 Oct 2026)', nickname: null },
  ]

  it('escapes plate, nickname and customName in the HTML part', () => {
    const { html } = renderReminderEmail(lines)
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;b&gt;CAB-1234&lt;/b&gt;')
    expect(html).toContain('Mum&#39;s &quot;car&quot; &amp; co')
  })

  it('has a plain-text part and a pluralized subject', () => {
    const { subject, text } = renderReminderEmail(lines)
    expect(subject).toBe('2 documents need attention')
    expect(text).toContain(`- Insurance · <b>CAB-1234</b> expires in 5 days (25 Oct 2026) (Mum's "car" & co)`)
    expect(renderReminderEmail(lines.slice(1)).subject).toBe('1 document needs attention')
  })
})

describe('sendEmail', () => {
  const email = { from: 'f@example.com', to: 't@example.com', subject: 's', html: 'h', text: 't' }

  it('posts to Resend with the API key and reports only the status code', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ message: 't@example.com is invalid' }, { status: 422 }))
    const outcome = await sendEmail(email, 'key-1')
    const req = new Request(fetchSpy.mock.calls[0]![0], fetchSpy.mock.calls[0]![1])
    expect(req.url).toBe('https://api.resend.com/emails')
    expect(req.headers.get('Authorization')).toBe('Bearer key-1')
    expect(outcome).toEqual({ ok: false, error: 'resend_422', status: 422 })
    expect(shouldRetryIndividually(outcome)).toBe(true)
  })

  it('maps network errors and does not retry server errors one by one', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('down'))
    expect(await sendEmail(email, 'k')).toEqual({ ok: false, error: 'resend_network', status: null })
    expect(shouldRetryIndividually({ ok: false, error: 'resend_500', status: 500 })).toBe(false)
  })
})
