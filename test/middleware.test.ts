import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../src/app'
import { generateKey, signHs256, signJwt, type TestKey } from './helpers/jwt'

// Test-only routes on the shared app instance; src has no test routes.
app.get('/v1/__test/me', (c) => c.json(c.var.user))
app.get('/v1/__test/boom', () => {
  throw new Error('relation "vehicles" secret SQL detail')
})
app.post('/v1/__test/echo', async (c) => c.json({ size: (await c.req.text()).length }))

const USER_ID = '11111111-1111-4111-8111-111111111111'

let es: TestKey
let rs: TestKey
const limit = vi.fn<RateLimit['limit']>()

const now = () => Math.floor(Date.now() / 1000)
const claims = (over: Record<string, unknown> = {}) => ({
  iss: env.SUPABASE_JWT_ISSUER,
  aud: 'authenticated',
  role: 'authenticated',
  sub: USER_ID,
  email: 'user@example.com',
  session_id: 'sess-1',
  iat: now() - 10,
  exp: now() + 3600,
  ...over,
})

const testEnv = (): CloudflareBindings => ({
  ...env,
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  RATE_LIMITER: { limit },
  STRICT_RATE_LIMITER: { limit },
})

const call = (path: string, init: RequestInit = {}) =>
  app.request(`https://api.test${path}`, init, testEnv())

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

type ErrorJson = { error: { code: string; message: string; requestId: string } }

async function expectError(res: Response, status: number, code: string): Promise<ErrorJson> {
  expect(res.status).toBe(status)
  const body = await res.json<ErrorJson>()
  expect(body.error.code).toBe(code)
  expect(body.error.requestId).toBeTruthy()
  return body
}

beforeAll(async () => {
  es = await generateKey('ES256', 'es-key')
  rs = await generateKey('RS256', 'rs-key')
})

beforeEach(() => {
  limit.mockReset()
  limit.mockResolvedValue({ success: true })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === env.SUPABASE_JWKS_URL) return Response.json({ keys: [es.jwk, rs.jwk] })
    throw new Error(`unexpected fetch ${url}`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auth', () => {
  it('accepts a valid ES256 token and sets the user', async () => {
    const res = await call('/v1/__test/me', bearer(await signJwt(es, claims())))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: USER_ID,
      email: 'user@example.com',
      sessionId: 'sess-1',
    })
  })

  it('accepts a valid RS256 token', async () => {
    const res = await call('/v1/__test/me', bearer(await signJwt(rs, claims())))
    expect(res.status).toBe(200)
  })

  it.each([
    ['expired', () => signJwt(es, claims({ exp: now() - 60 }))],
    ['without exp', () => signJwt(es, claims({ exp: undefined }))],
    ['from a wrong issuer', () => signJwt(es, claims({ iss: 'https://evil.example/auth/v1' }))],
    ['for a wrong audience', () => signJwt(es, claims({ aud: 'anon' }))],
    ['for the anon role', () => signJwt(es, claims({ role: 'anon' }))],
    ['missing sub', () => signJwt(es, claims({ sub: undefined }))],
    ['with an empty sub', () => signJwt(es, claims({ sub: '' }))],
    ['HS256', () => signHs256('es-key', claims())],
    ['signed with an unknown kid', () => signJwt(es, claims(), { kid: 'other' })],
    ['malformed', async () => 'not.a.jwt'],
    ['tampered', async () => `${(await signJwt(es, claims())).slice(0, -4)}AAAA`],
  ])('rejects a token that is %s with 401', async (_name, make) => {
    await expectError(await call('/v1/__test/me', bearer(await make())), 401, 'unauthorized')
  })

  it('rejects a missing token', async () => {
    await expectError(await call('/v1/__test/me'), 401, 'unauthorized')
  })

  it('rejects a non-Bearer scheme', async () => {
    const token = await signJwt(es, claims())
    const res = await call('/v1/__test/me', { headers: { Authorization: `Basic ${token}` } })
    await expectError(res, 401, 'unauthorized')
  })

  it('ignores a token in the query string', async () => {
    const token = await signJwt(es, claims())
    await expectError(await call(`/v1/__test/me?access_token=${token}`), 401, 'unauthorized')
  })

  it('keeps /v1/health public and unlimited', async () => {
    const res = await call('/v1/health')
    expect(res.status).toBe(200)
    expect(limit).not.toHaveBeenCalled()
  })

  it('returns 500 (not 401) when the JWKS cannot be fetched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fetch).mockImplementation(async () => new Response('down', { status: 503 }))
    const res = await call('/v1/__test/me', bearer(await signJwt(es, claims())))
    await expectError(res, 500, 'internal_error')
  })
})

describe('errors', () => {
  it('returns the 404 shape for unknown routes', async () => {
    const res = await call('/v1/nope', bearer(await signJwt(es, claims())))
    await expectError(res, 404, 'not_found')
  })

  it('requires auth before revealing that a route does not exist', async () => {
    await expectError(await call('/v1/nope'), 401, 'unauthorized')
  })

  it('hides internal error messages behind a 500 and logs them server-side', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('/v1/__test/boom', bearer(await signJwt(es, claims())))
    const body = await expectError(res, 500, 'internal_error')
    expect(body.error.message).toBe('Internal server error')
    expect(JSON.stringify(body)).not.toContain('secret SQL')
    expect(errorLog).toHaveBeenCalledOnce()
    const logged = String(errorLog.mock.calls[0]?.[0])
    expect(logged).toContain(body.error.requestId)
    expect(logged).toContain('secret SQL')
  })
})

describe('body limit', () => {
  const big = 'x'.repeat(101 * 1024)

  it('rejects bodies over 100 KB with 413', async () => {
    const res = await call('/v1/__test/echo', { method: 'POST', body: big })
    await expectError(res, 413, 'payload_too_large')
  })

  it('allows more than 100 KB on /v1/sync', async () => {
    const res = await call('/v1/sync', {
      method: 'POST',
      body: big,
      ...bearer(await signJwt(es, claims())),
    })
    // Past the body limit: the sync route's validator rejects the non-JSON body.
    await expectError(res, 400, 'validation_failed')
  })

  it('rejects bodies over 1 MB on /v1/sync', async () => {
    const res = await call('/v1/sync', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
    await expectError(res, 413, 'payload_too_large')
  })
})

describe('rate limit', () => {
  it('keys the limiter by user id', async () => {
    await call('/v1/__test/me', bearer(await signJwt(es, claims())))
    expect(limit).toHaveBeenCalledWith({ key: USER_ID })
  })

  it('returns 429 when over the limit', async () => {
    limit.mockResolvedValue({ success: false })
    const res = await call('/v1/__test/me', bearer(await signJwt(es, claims())))
    await expectError(res, 429, 'rate_limited')
  })
})

describe('logger', () => {
  it('writes one JSON line without tokens, query strings or user data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const token = await signJwt(es, claims())
    const res = await call('/v1/__test/me?plate=CAB-1234', bearer(token))
    expect(log).toHaveBeenCalledOnce()
    const line = String(log.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      requestId: res.headers.get('X-Request-Id'),
      method: 'GET',
      route: '/v1/__test/me',
      status: 200,
      durationMs: expect.any(Number),
    })
    expect(line).not.toContain(token)
    expect(line).not.toContain('CAB-1234')
    expect(line).not.toContain('user@example.com')
  })
})
