import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getJwks, JWKS_MIN_REFRESH_MS, JWKS_TTL_MS, resetJwksCache, tokenKid } from '../src/lib/jwks'

const URL_A = 'https://a.test/jwks.json'
const T0 = 1_000_000_000

const keySet = (...kids: string[]) => ({ keys: kids.map((kid) => ({ kid, kty: 'EC' })) })

let served: object
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  resetJwksCache()
  served = keySet('k1')
  fetchMock = vi.fn<typeof fetch>(async () => Response.json(served))
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getJwks', () => {
  it('fetches once and serves later requests from memory', async () => {
    await getJwks(URL_A, 'k1', T0)
    const keys = await getJwks(URL_A, 'k1', T0 + JWKS_TTL_MS - 1)
    expect(keys.map((k) => k.kid)).toEqual(['k1'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refetches after the TTL', async () => {
    await getJwks(URL_A, 'k1', T0)
    await getJwks(URL_A, 'k1', T0 + JWKS_TTL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refetches early for an unknown kid, but at most once per interval', async () => {
    await getJwks(URL_A, 'k1', T0)
    // Forged kids inside the interval cost no fetch.
    await getJwks(URL_A, 'forged-1', T0 + 1)
    await getJwks(URL_A, 'forged-2', T0 + JWKS_MIN_REFRESH_MS - 1)
    expect(fetchMock).toHaveBeenCalledOnce()

    served = keySet('k1', 'k2')
    const keys = await getJwks(URL_A, 'k2', T0 + JWKS_MIN_REFRESH_MS)
    expect(keys.map((k) => k.kid)).toEqual(['k1', 'k2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares one fetch between concurrent requests', async () => {
    await Promise.all([getJwks(URL_A, 'k1', T0), getJwks(URL_A, 'k1', T0), getJwks(URL_A, 'k1', T0)])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps serving stale keys when a refetch fails, without retrying every request', async () => {
    await getJwks(URL_A, 'k1', T0)
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    const t1 = T0 + JWKS_TTL_MS
    expect((await getJwks(URL_A, 'k1', t1)).map((k) => k.kid)).toEqual(['k1'])
    await getJwks(URL_A, 'k1', t1 + 1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when there are no keys at all', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    await expect(getJwks(URL_A, 'k1', T0)).rejects.toThrow('failed to fetch JWKS')
  })

  it('rejects a response without a keys array', async () => {
    served = { nope: true }
    await expect(getJwks(URL_A, 'k1', T0)).rejects.toThrow('invalid JWKS response')
  })
})

describe('tokenKid', () => {
  const b64url = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '')

  it('reads the kid from the header', () => {
    expect(tokenKid(`${b64url({ alg: 'ES256', kid: 'k1' })}.e30.sig`)).toBe('k1')
  })

  it.each([undefined, '', 'not-a-jwt', `${b64url({ alg: 'ES256' })}.e30.sig`, `${b64url({ kid: 7 })}.e30.sig`])(
    'returns undefined for %s',
    (token) => {
      expect(tokenKid(token)).toBeUndefined()
    },
  )
})
