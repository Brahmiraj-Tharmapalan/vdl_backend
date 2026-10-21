import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tables } from '../src/types/db'
import {
  bearerSub,
  expectCamelCase,
  expectError,
  json,
  setupHarness,
  USER_A,
  type Harness,
} from './helpers/api'

const profile = (over: Partial<Tables<'profiles'>> = {}): Tables<'profiles'> => ({
  id: USER_A,
  display_name: 'Nimal',
  reminder_email: 'nimal@example.com',
  push_enabled: true,
  email_enabled: true,
  default_reminder_days: [30, 7, 1],
  theme: 'system',
  last_synced_at: null,
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-19T00:00:00+00:00',
  ...over,
})

let h: Harness

beforeEach(async () => {
  h = await setupHarness()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /v1/me', () => {
  it('returns the profile in camelCase with the auth id and email', async () => {
    h.supabase(() => Response.json([profile()]))
    const res = await h.authed('/v1/me')
    expect(res.status).toBe(200)
    const body = await res.json<Record<string, unknown>>()
    expect(body).toEqual({
      id: USER_A,
      email: '1111@example.com',
      displayName: 'Nimal',
      reminderEmail: 'nimal@example.com',
      pushEnabled: true,
      emailEnabled: true,
      defaultReminderDays: [30, 7, 1],
      theme: 'system',
      lastSyncedAt: null,
      updatedAt: '2026-10-19T00:00:00+00:00',
    })
    expectCamelCase(body)
  })

  it('queries with the user JWT, filtered by the token user id', async () => {
    h.supabase(() => Response.json([profile()]))
    await h.authed('/v1/me')
    const [call] = h.calls
    expect(call?.url.pathname).toBe('/rest/v1/profiles')
    expect(call?.url.searchParams.get('id')).toBe(`eq.${USER_A}`)
    expect(bearerSub(call?.authorization)).toBe(USER_A)
  })

  it('returns 404 when the profile row is missing', async () => {
    h.supabase(() => Response.json([]))
    await expectError(await h.authed('/v1/me'), 404, 'not_found')
  })

  it('hides Supabase errors behind a 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.supabase(() =>
      Response.json({ code: '42501', message: 'permission denied for table profiles' }, {
        status: 403,
      }),
    )
    const body = await expectError(await h.authed('/v1/me'), 500, 'internal_error')
    expect(JSON.stringify(body)).not.toContain('permission denied')
  })

  it('requires a token', async () => {
    await expectError(await h.call('/v1/me'), 401, 'unauthorized')
  })
})

describe('PATCH /v1/me', () => {
  const patch = (body: unknown) => h.authed('/v1/me', { method: 'PATCH', ...json(body) })

  it('uses the strict and write limiters (a toggle rebuilds all reminders)', async () => {
    h.strictLimit.mockResolvedValue({ success: false })
    await expectError(await patch({ theme: 'dark' }), 429, 'rate_limited')
    expect(h.writeLimit).toHaveBeenCalledWith({ key: USER_A })
    expect(h.calls).toHaveLength(0)
  })

  it('sends only the given fields, in snake_case', async () => {
    h.supabase(() => Response.json([profile({ theme: 'dark', default_reminder_days: [14] })]))
    const res = await patch({ theme: 'dark', defaultReminderDays: [14], displayName: null })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ theme: 'dark', defaultReminderDays: [14] })
    const [call] = h.calls
    expect(call?.method).toBe('PATCH')
    expect(call?.url.searchParams.get('id')).toBe(`eq.${USER_A}`)
    expect(call?.body).toEqual({ theme: 'dark', default_reminder_days: [14], display_name: null })
    expect(h.calls).toHaveLength(1) // no reminder rebuild without a channel toggle
  })

  it.each([
    ['pushEnabled', { pushEnabled: false }],
    ['emailEnabled', { emailEnabled: true }],
  ])('rebuilds all reminders when %s is sent', async (_name, body) => {
    h.supabase((call) =>
      call.url.pathname.startsWith('/rest/v1/rpc/')
        ? new Response(null, { status: 204 })
        : Response.json([profile()]),
    )
    expect((await patch(body)).status).toBe(200)
    const rpc = h.calls[1]
    expect(rpc?.method).toBe('POST')
    expect(rpc?.url.pathname).toBe('/rest/v1/rpc/rebuild_reminders')
    expect(rpc?.body).toEqual({})
    expect(bearerSub(rpc?.authorization)).toBe(USER_A)
  })

  it('returns 500 when the reminder rebuild fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.supabase((call) =>
      call.url.pathname.startsWith('/rest/v1/rpc/')
        ? Response.json({ code: 'XX000', message: 'boom' }, { status: 500 })
        : Response.json([profile()]),
    )
    await expectError(await patch({ pushEnabled: true }), 500, 'internal_error')
  })

  it.each([
    ['an empty body', {}],
    ['an unknown field', { theme: 'dark', userId: 'x' }],
    ['a bad email', { reminderEmail: 'not-an-email' }],
    ['a bad theme', { theme: 'pink' }],
    ['too many reminder days', { defaultReminderDays: [1, 2, 3, 4, 5, 6, 7] }],
    ['a reminder day out of range', { defaultReminderDays: [0] }],
    ['a too-long display name', { displayName: 'x'.repeat(101) }],
    ['a non-boolean toggle', { pushEnabled: 'yes' }],
  ])('rejects %s with 400', async (_name, body) => {
    await expectError(await patch(body), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects an oversized body with 413', async () => {
    const res = await patch({ displayName: 'x'.repeat(101 * 1024) })
    await expectError(res, 413, 'payload_too_large')
  })

  it('accepts the sign-in email (any case) or null as reminderEmail', async () => {
    h.supabase(() => Response.json([profile()]))
    expect((await patch({ reminderEmail: '1111@EXAMPLE.com' })).status).toBe(200)
    expect((await patch({ reminderEmail: null })).status).toBe(200)
  })

  it('rejects a reminderEmail other than the sign-in email, without writing', async () => {
    const res = await patch({ reminderEmail: 'someone-else@example.com' })
    const body = await expectError(res, 400, 'validation_failed')
    expect(JSON.stringify(body)).toContain('reminderEmail')
    expect(JSON.stringify(body)).not.toContain('someone-else')
    expect(h.calls).toHaveLength(0)
  })

  it('returns 400 (not 500) when the DB rejects an unconfirmed reminderEmail', async () => {
    h.supabase(() =>
      Response.json(
        { code: '23514', message: 'reminder_email must be the confirmed account email' },
        { status: 400 },
      ),
    )
    const res = await patch({ reminderEmail: '1111@example.com' })
    const body = await expectError(res, 400, 'validation_failed')
    expect(JSON.stringify(body)).toContain('reminderEmail')
    expect(JSON.stringify(body)).not.toContain('confirmed account email')
    expect(h.calls).toHaveLength(1)
  })

  it('still returns 500 for other check violations', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.supabase(() =>
      Response.json({ code: '23514', message: 'violates check constraint "x"' }, { status: 400 }),
    )
    await expectError(await patch({ theme: 'dark' }), 500, 'internal_error')
  })
})

describe('DELETE /v1/me', () => {
  it('deletes the auth user with the service client and returns 204', async () => {
    h.supabase(() => Response.json({}))
    const res = await h.authed('/v1/me', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(h.calls).toHaveLength(1)
    const [call] = h.calls
    expect(call?.method).toBe('DELETE')
    expect(call?.url.href).toBe(`${env.SUPABASE_URL}/auth/v1/admin/users/${USER_A}`)
    expect(call?.authorization).toBe('Bearer test-service-key')
  })

  it.each([
    ['a sign-in older than 10 minutes', { amr: [{ method: 'oauth', timestamp: Math.floor(Date.now() / 1000) - 11 * 60 }] }],
    ['no amr claim', { amr: undefined }],
  ])('returns 403 reauth_required without deleting for %s', async (_name, claims) => {
    const res = await h.authed('/v1/me', { method: 'DELETE' }, USER_A, claims)
    await expectError(res, 403, 'reauth_required')
    expect(h.calls).toHaveLength(0)
  })

  it('uses the strict rate limit', async () => {
    h.supabase(() => Response.json({}))
    await h.authed('/v1/me', { method: 'DELETE' })
    expect(h.strictLimit).toHaveBeenCalledWith({ key: USER_A })
  })

  it('returns 429 without deleting when over the strict limit', async () => {
    h.strictLimit.mockResolvedValue({ success: false })
    await expectError(await h.authed('/v1/me', { method: 'DELETE' }), 429, 'rate_limited')
    expect(h.calls).toHaveLength(0)
  })

  it('returns a generic 500 and logs server-side when the admin call fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.supabase(() => Response.json({ code: 'user_not_found', msg: 'User not found' }, { status: 404 }))
    const body = await expectError(await h.authed('/v1/me', { method: 'DELETE' }), 500, 'internal_error')
    expect(JSON.stringify(body)).not.toContain('User not found')
    expect(String(errorLog.mock.calls[0]?.[0])).toContain(body.error.requestId)
  })
})
