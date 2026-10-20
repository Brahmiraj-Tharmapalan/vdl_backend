import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tables } from '../src/types/db'
import {
  bearerSub,
  expectCamelCase,
  expectError,
  json,
  setupHarness,
  USER_A,
  USER_B,
  type Harness,
} from './helpers/api'

const DEVICE_ID = '33333333-3333-4333-8333-333333333333'
const PUSH_TOKEN = 'ExponentPushToken[abc123]'

const device = (over: Partial<Tables<'devices'>> = {}): Tables<'devices'> => ({
  id: DEVICE_ID,
  user_id: USER_A,
  push_token: PUSH_TOKEN,
  platform: 'android',
  device_name: 'Pixel 8',
  last_seen_at: '2026-10-20T00:00:00+00:00',
  created_at: '2026-10-19T00:00:00+00:00',
  updated_at: '2026-10-20T00:00:00+00:00',
  ...over,
})

const apiDevice = {
  id: DEVICE_ID,
  platform: 'android',
  deviceName: 'Pixel 8',
  lastSeenAt: '2026-10-20T00:00:00+00:00',
  createdAt: '2026-10-19T00:00:00+00:00',
}

let h: Harness

beforeEach(async () => {
  h = await setupHarness()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /v1/devices', () => {
  it('lists devices in camelCase without user_id or push token', async () => {
    h.supabase(() => Response.json([device()]))
    const res = await h.authed('/v1/devices')
    expect(res.status).toBe(200)
    const body = await res.json<{ devices: Record<string, unknown>[] }>()
    expect(body).toEqual({ devices: [apiDevice] })
    expectCamelCase(body.devices[0] ?? {})
    expect(JSON.stringify(body)).not.toContain(PUSH_TOKEN)
    expect(h.calls[0]?.url.searchParams.get('user_id')).toBe(`eq.${USER_A}`)
  })
})

describe('POST /v1/devices', () => {
  const register = (body: unknown, sub?: string) =>
    h.authed('/v1/devices', { method: 'POST', ...json(body) }, sub)

  it('registers through the register_device RPC with the user JWT', async () => {
    h.supabase(() => Response.json(device({ user_id: USER_B })))
    const res = await register(
      { pushToken: ` ${PUSH_TOKEN} `, platform: 'android', deviceName: 'Pixel 8' },
      USER_B,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(apiDevice)
    const [call] = h.calls
    expect(call?.method).toBe('POST')
    expect(call?.url.pathname).toBe('/rest/v1/rpc/register_device')
    expect(bearerSub(call?.authorization)).toBe(USER_B)
    // user_id is never sent; the DB takes it from auth.uid().
    expect(call?.body).toEqual({
      p_push_token: PUSH_TOKEN,
      p_platform: 'android',
      p_device_name: 'Pixel 8',
    })
  })

  it('omits the device name when not given', async () => {
    h.supabase(() => Response.json(device({ device_name: null })))
    await register({ pushToken: PUSH_TOKEN, platform: 'ios' })
    expect(h.calls[0]?.body).toEqual({ p_push_token: PUSH_TOKEN, p_platform: 'ios' })
  })

  it('uses the strict rate limit', async () => {
    h.supabase(() => Response.json(device()))
    await register({ pushToken: PUSH_TOKEN, platform: 'android' })
    expect(h.strictLimit).toHaveBeenCalledWith({ key: USER_A })
  })

  it.each([
    ['an unknown field', { pushToken: PUSH_TOKEN, platform: 'android', userId: USER_B }],
    ['a missing token', { platform: 'android' }],
    ['an empty token', { pushToken: '  ', platform: 'android' }],
    ['a too-long token', { pushToken: 'x'.repeat(256), platform: 'android' }],
    ['a non-Expo token', { pushToken: 'fcm:abc123', platform: 'android' }],
    ['an empty Expo token', { pushToken: 'ExponentPushToken[]', platform: 'android' }],
    ['a bad platform', { pushToken: PUSH_TOKEN, platform: 'windows' }],
    ['a too-long device name', { pushToken: PUSH_TOKEN, platform: 'ios', deviceName: 'x'.repeat(101) }],
  ])('rejects %s with 400', async (_name, body) => {
    await expectError(await register(body), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })

  it('rejects an oversized body with 413', async () => {
    const res = await register({ pushToken: 'x'.repeat(101 * 1024), platform: 'ios' })
    await expectError(res, 413, 'payload_too_large')
  })
})

describe('PATCH /v1/devices/:id/seen', () => {
  const seen = (id: string, sub?: string) =>
    h.authed(`/v1/devices/${id}/seen`, { method: 'PATCH' }, sub)

  it('updates last_seen_at and returns the device', async () => {
    h.supabase(() => Response.json([device()]))
    const res = await seen(DEVICE_ID)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(apiDevice)
    const [call] = h.calls
    expect(call?.method).toBe('PATCH')
    expect(call?.url.searchParams.get('id')).toBe(`eq.${DEVICE_ID}`)
    expect(Object.keys(call?.body ?? {})).toEqual(['last_seen_at'])
  })

  it("returns 404 for user B on user A's device", async () => {
    // RLS hides A's row from B, so PostgREST updates nothing.
    h.supabase(() => Response.json([]))
    await expectError(await seen(DEVICE_ID, USER_B), 404, 'not_found')
    expect(bearerSub(h.calls[0]?.authorization)).toBe(USER_B)
  })

  it('rejects a bad UUID with 400', async () => {
    await expectError(await seen('not-a-uuid'), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })
})

describe('DELETE /v1/devices/:id', () => {
  const remove = (id: string, sub?: string) =>
    h.authed(`/v1/devices/${id}`, { method: 'DELETE' }, sub)

  it('deletes the device and returns 204', async () => {
    h.supabase(() => Response.json([{ id: DEVICE_ID }]))
    const res = await remove(DEVICE_ID)
    expect(res.status).toBe(204)
    expect(h.calls[0]?.method).toBe('DELETE')
    expect(h.calls[0]?.url.searchParams.get('id')).toBe(`eq.${DEVICE_ID}`)
  })

  it("returns 404 for user B on user A's device", async () => {
    h.supabase(() => Response.json([]))
    await expectError(await remove(DEVICE_ID, USER_B), 404, 'not_found')
  })

  it('rejects a bad UUID with 400', async () => {
    await expectError(await remove('123'), 400, 'validation_failed')
    expect(h.calls).toHaveLength(0)
  })
})
