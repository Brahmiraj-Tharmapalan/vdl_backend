// Shared harness for route tests: signed tokens, fake rate limiters and a Supabase HTTP stub.
// supabase-js calls the global fetch, so stubbing fetch covers PostgREST and the Auth admin API.
import { env } from 'cloudflare:workers'
import { expect, vi } from 'vitest'
import app from '../../src/app'
import { generateKey, signJwt, type TestKey } from './jwt'

export const USER_A = '11111111-1111-4111-8111-111111111111'
export const USER_B = '22222222-2222-4222-8222-222222222222'

export type SupabaseCall = {
  method: string
  url: URL
  authorization: string | null
  apikey: string | null
  body: unknown
}

type Handler = (call: SupabaseCall) => Response | Promise<Response>

export type Harness = {
  limit: ReturnType<typeof vi.fn<RateLimit['limit']>>
  strictLimit: ReturnType<typeof vi.fn<RateLimit['limit']>>
  /** Every request made to Supabase (excluding the JWKS). */
  calls: SupabaseCall[]
  /** Responds to Supabase requests; set per test. */
  supabase: (handler: Handler) => void
  token: (sub?: string) => Promise<string>
  call: (path: string, init?: RequestInit) => Promise<Response>
  /** `call` with a Bearer token for `sub` (default user A). */
  authed: (path: string, init?: RequestInit, sub?: string) => Promise<Response>
}

const now = () => Math.floor(Date.now() / 1000)

let key: TestKey | undefined

/** Call in `beforeEach`; `vi.restoreAllMocks()` in `afterEach` undoes the fetch spy. */
export async function setupHarness(): Promise<Harness> {
  key ??= await generateKey('ES256', 'es-key')
  const signingKey = key

  const limit = vi.fn<RateLimit['limit']>().mockResolvedValue({ success: true })
  const strictLimit = vi.fn<RateLimit['limit']>().mockResolvedValue({ success: true })
  const calls: SupabaseCall[] = []
  let handler: Handler = () => {
    throw new Error('unexpected Supabase call')
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    if (req.url === env.SUPABASE_JWKS_URL) return Response.json({ keys: [signingKey.jwk] })
    if (!req.url.startsWith(env.SUPABASE_URL)) throw new Error(`unexpected fetch ${req.url}`)
    const text = await req.text()
    const call: SupabaseCall = {
      method: req.method,
      url: new URL(req.url),
      authorization: req.headers.get('Authorization'),
      apikey: req.headers.get('apikey'),
      body: text ? JSON.parse(text) : undefined,
    }
    calls.push(call)
    return handler(call)
  })

  const testEnv = (): CloudflareBindings => ({
    ...env,
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    RATE_LIMITER: { limit },
    STRICT_RATE_LIMITER: { limit: strictLimit },
  })

  const token = (sub = USER_A) =>
    signJwt(signingKey, {
      iss: env.SUPABASE_JWT_ISSUER,
      aud: 'authenticated',
      role: 'authenticated',
      sub,
      email: `${sub.slice(0, 4)}@example.com`,
      session_id: 'sess-1',
      iat: now() - 10,
      exp: now() + 3600,
    })

  const call = async (path: string, init: RequestInit = {}) =>
    app.request(`https://api.test${path}`, init, testEnv())

  const authed = async (path: string, init: RequestInit = {}, sub = USER_A) =>
    call(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await token(sub)}` },
    })

  return {
    limit,
    strictLimit,
    calls,
    supabase: (h) => {
      handler = h
    },
    token,
    call,
    authed,
  }
}

export const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

type ErrorJson = { error: { code: string; message: string; requestId: string } }

export async function expectError(res: Response, status: number, code: string): Promise<ErrorJson> {
  expect(res.status).toBe(status)
  const body = await res.json<ErrorJson>()
  expect(body.error.code).toBe(code)
  expect(body.error.requestId).toBeTruthy()
  return body
}

/** `sub` of the Bearer token Supabase received (ES256 signatures differ per signing). */
export function bearerSub(authorization: string | null | undefined): unknown {
  const payload = authorization?.replace(/^Bearer /, '').split('.')[1] ?? ''
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  return (JSON.parse(atob(b64)) as { sub?: unknown }).sub
}

/** Asserts no snake_case keys leak into an API object. */
export function expectCamelCase(value: object) {
  for (const k of Object.keys(value)) expect(k).not.toContain('_')
}
