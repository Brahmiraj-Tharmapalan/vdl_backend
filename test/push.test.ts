import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPO_PUSH_URL, chunk, sendPushChunk, type PushMessage } from '../src/lib/push'

afterEach(() => vi.restoreAllMocks())

const msg = (to: string): PushMessage => ({ to, title: 't', body: 'b', sound: 'default', data: {} })

describe('chunk', () => {
  it('splits 250 items into 100 + 100 + 50', () => {
    const items = Array.from({ length: 250 }, (_, i) => i)
    expect(chunk(items, 100).map((c) => c.length)).toEqual([100, 100, 50])
    expect(chunk([], 100)).toEqual([])
  })
})

describe('sendPushChunk', () => {
  it('sends with the access token and maps tickets in order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          { status: 'ok', id: 'r1' },
          {
            status: 'error',
            message: '"ExponentPushToken[dead]" is not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'error', message: 'ExponentPushToken[x] weird', details: { error: 'bad code <x>' } },
        ],
      }),
    )
    const out = await sendPushChunk([msg('a'), msg('ExponentPushToken[dead]'), msg('x')], 'expo-token')

    const req = new Request(fetchSpy.mock.calls[0]![0], fetchSpy.mock.calls[0]![1])
    expect(req.url).toBe(EXPO_PUSH_URL)
    expect(req.headers.get('Authorization')).toBe('Bearer expo-token')
    expect(out).toEqual([
      { ok: true },
      { ok: false, error: 'expo_DeviceNotRegistered', deviceNotRegistered: true },
      { ok: false, error: 'expo_error', deviceNotRegistered: false },
    ])
    expect(JSON.stringify(out)).not.toContain('ExponentPushToken')
  })

  it('fails every message on a request error or a malformed response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ data: [{ status: 'ok' }] }))
      .mockRejectedValueOnce(new Error('down'))
    const two = [msg('a'), msg('b')]
    expect((await sendPushChunk(two, 't')).map((o) => !o.ok && o.error)).toEqual(['expo_429', 'expo_429'])
    expect((await sendPushChunk(two, 't')).map((o) => !o.ok && o.error)).toEqual([
      'expo_bad_response',
      'expo_bad_response',
    ])
    expect((await sendPushChunk(two, 't')).map((o) => !o.ok && o.error)).toEqual(['expo_network', 'expo_network'])
  })
})
