/**
 * In-memory JWKS cache for the auth middleware. Hono's `jwk` with `jwks_uri` fetches the JWKS on
 * every request; this keeps it per isolate instead, so a request costs no extra subrequest and a
 * flood of forged tokens can't turn into a flood of JWKS fetches.
 */

export type Jwk = JsonWebKey & { kid?: string }

/** Keys are refetched after this long. */
export const JWKS_TTL_MS = 10 * 60_000
/** An unknown `kid` (key rotation) refetches early, but at most this often. */
export const JWKS_MIN_REFRESH_MS = 60_000

type Cache = { url: string; keys: Jwk[]; fetchedAt: number }

let cache: Cache | undefined
let inflight: { url: string; promise: Promise<Jwk[]> } | undefined

/** Test-only: forget the cached keys. */
export function resetJwksCache(): void {
  cache = undefined
  inflight = undefined
}

/** `kid` from a JWT's header, or undefined if it isn't a readable JWT. */
export function tokenKid(token: string | undefined): string | undefined {
  const part = token?.split('.')[0]
  if (!part) return undefined
  try {
    const header: unknown = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof header === 'object' && header !== null && 'kid' in header) {
      return typeof header.kid === 'string' ? header.kid : undefined
    }
  } catch {
    // Not a JWT: verification rejects it with a 401.
  }
  return undefined
}

async function fetchJwks(url: string): Promise<Jwk[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to fetch JWKS (HTTP ${res.status})`)
  const data: unknown = await res.json()
  if (typeof data !== 'object' || data === null || !('keys' in data) || !Array.isArray(data.keys)) {
    throw new Error('invalid JWKS response')
  }
  return data.keys as Jwk[]
}

/**
 * The keys from `url`, fetched at most once per TTL, plus once per minute when a token names a
 * `kid` the cache doesn't have. If a refetch fails, stale keys are used; with no keys at all the
 * error is thrown (the request becomes a 500, not a 401).
 */
export async function getJwks(url: string, kid: string | undefined, now = Date.now()): Promise<Jwk[]> {
  const current = cache?.url === url ? cache : undefined
  if (current) {
    const age = now - current.fetchedAt
    const known = kid === undefined || current.keys.some((k) => k.kid === kid)
    if (age < JWKS_MIN_REFRESH_MS || (age < JWKS_TTL_MS && known)) return current.keys
  }

  // Concurrent requests share one fetch.
  if (inflight?.url !== url) {
    const promise = fetchJwks(url).finally(() => {
      if (inflight?.promise === promise) inflight = undefined
    })
    inflight = { url, promise }
  }
  try {
    const keys = await inflight.promise
    cache = { url, keys, fetchedAt: now }
    return keys
  } catch (err) {
    if (current) {
      // Keep serving the old keys without retrying on every request.
      cache = { ...current, fetchedAt: now }
      return current.keys
    }
    throw err
  }
}
