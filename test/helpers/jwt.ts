// Test-only JWT signing with locally generated keys, so tests never hit Supabase.

const enc = new TextEncoder()

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const b64urlJson = (value: object) => b64url(enc.encode(JSON.stringify(value)))

export type TestKey = {
  kid: string
  alg: 'ES256' | 'RS256'
  privateKey: CryptoKey
  jwk: JsonWebKey
}

const PARAMS = {
  ES256: {
    gen: { name: 'ECDSA', namedCurve: 'P-256' },
    sign: { name: 'ECDSA', hash: 'SHA-256' },
  },
  RS256: {
    gen: {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    sign: { name: 'RSASSA-PKCS1-v1_5' },
  },
} as const

export async function generateKey(alg: 'ES256' | 'RS256', kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(PARAMS[alg].gen, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  return { kid, alg, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg } as JsonWebKey }
}

export async function signJwt(
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = b64urlJson({ alg: key.alg, typ: 'JWT', kid: key.kid, ...header })
  const input = `${head}.${b64urlJson(payload)}`
  const sig = await crypto.subtle.sign(PARAMS[key.alg].sign, key.privateKey, enc.encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

/** HS256 token with a known kid, to prove symmetric algorithms are rejected. */
export async function signHs256(kid: string, payload: Record<string, unknown>): Promise<string> {
  const secret = await crypto.subtle.importKey(
    'raw',
    enc.encode('test-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const input = `${b64urlJson({ alg: 'HS256', typ: 'JWT', kid })}.${b64urlJson(payload)}`
  const sig = await crypto.subtle.sign('HMAC', secret, enc.encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}
