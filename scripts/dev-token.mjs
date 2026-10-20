// Gets an access token for a DEV test user (email + password) and saves it to .smoke-token
// (gitignored) for `npm run smoke`. Tokens last ~1 h; re-run when the smoke test gets 401.
//
// PowerShell:  $env:SMOKE_EMAIL='you@example.com'; $env:SMOKE_PASSWORD='...'; npm run dev-token
// Reads SUPABASE_ANON_KEY from .dev.vars and the dev SUPABASE_URL from wrangler.jsonc.
import { readFileSync, writeFileSync } from 'node:fs'

const email = process.env.SMOKE_EMAIL
const password = process.env.SMOKE_PASSWORD
if (!email || !password) {
  console.error('Set SMOKE_EMAIL and SMOKE_PASSWORD in your shell first.')
  process.exit(1)
}

const anonKey = readFileSync('.dev.vars', 'utf8').match(/^SUPABASE_ANON_KEY=(.+)$/m)?.[1]?.trim()
// The first SUPABASE_URL in wrangler.jsonc is the top-level (dev) one.
const url = readFileSync('wrangler.jsonc', 'utf8').match(/"SUPABASE_URL":\s*"([^"]+)"/)?.[1]
if (!anonKey || !url) {
  console.error('Missing SUPABASE_ANON_KEY in .dev.vars or SUPABASE_URL in wrangler.jsonc.')
  process.exit(1)
}

const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const body = await res.json().catch(() => ({}))
// exitCode, not process.exit(): exiting right after fetch crashes Node on Windows (libuv assert).
if (!res.ok || typeof body.access_token !== 'string') {
  console.error(`Sign-in failed: HTTP ${res.status} ${body.error_code ?? body.error ?? ''}`)
  process.exitCode = 1
} else {
  writeFileSync('.smoke-token', body.access_token)
  console.log(`Saved an access token to .smoke-token (expires in ${body.expires_in} s).`)
}
