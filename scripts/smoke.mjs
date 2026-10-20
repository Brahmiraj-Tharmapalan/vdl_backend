// End-to-end smoke test of every /v1 route against a running Worker and a real Supabase project.
// Token: SMOKE_TOKEN env or .smoke-token (see scripts/dev-token.mjs). BASE_URL defaults to
// http://localhost:8787 (`npm run dev`). It creates rows with fresh UUIDs and soft-deletes them
// at the end. It never calls DELETE /v1/me. Prints only statuses, never response bodies.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const BASE = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '')
const TOKEN =
  process.env.SMOKE_TOKEN ?? (existsSync('.smoke-token') ? readFileSync('.smoke-token', 'utf8').trim() : '')
if (!TOKEN) {
  console.error('No token: set SMOKE_TOKEN or run `npm run dev-token` first.')
  process.exit(1)
}

let failures = 0
function check(name, ok, info = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !info ? '' : `  (${info})`}`)
  return ok
}

async function call(method, path, body, token = TOKEN) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, json }
}

/** Calls and checks the status; returns the parsed body. */
async function expect(name, method, path, status, body, token) {
  const res = await call(method, path, body, token)
  check(name, res.status === status, `got ${res.status}${res.json?.error ? ` ${res.json.error.code}` : ''}`)
  return res.json
}

const colomboToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const today = colomboToday()
const ids = (list) => (list ?? []).map((x) => x.id)

console.log(`Smoke test against ${BASE} (today in Colombo: ${today})\n`)

// --- Public + auth ---
await expect('GET /health', 'GET', '/v1/health', 200, undefined, '')
await expect('GET /me without token → 401', 'GET', '/v1/me', 401, undefined, '')
await expect('GET /me with bad token → 401', 'GET', '/v1/me', 401, undefined, 'not.a.jwt')

// --- Profile ---
const me = await expect('GET /me', 'GET', '/v1/me', 200)
check('me has id + defaultReminderDays', !!me?.id && Array.isArray(me?.defaultReminderDays))
const originalTheme = me?.theme ?? 'system'
const patched = await expect('PATCH /me theme', 'PATCH', '/v1/me', 200, { theme: 'dark' })
check('me.theme = dark', patched?.theme === 'dark')
await expect('PATCH /me unknown field → 400', 'PATCH', '/v1/me', 400, { userId: 'x' })

// --- Vehicles ---
const v1 = randomUUID()
const vehicle = { id: v1, nickname: 'Smoke car', plateNumber: 'smk-1234', type: 'car' }
const created = await expect('POST /vehicles → 201', 'POST', '/v1/vehicles', 201, vehicle)
check('plate is uppercased', created?.plateNumber === 'SMK-1234')
check('no user_id in response', created && !('userId' in created) && !('user_id' in created))
await expect('POST /vehicles same id → 200', 'POST', '/v1/vehicles', 200, vehicle)
const vlist = await expect('GET /vehicles', 'GET', '/v1/vehicles', 200)
check('vehicle listed', ids(vlist?.vehicles).includes(v1))
await expect('GET /vehicles/:id', 'GET', `/v1/vehicles/${v1}`, 200)
await expect('GET /vehicles/not-a-uuid → 400', 'GET', '/v1/vehicles/not-a-uuid', 400)
await expect('GET /vehicles/<random> → 404', 'GET', `/v1/vehicles/${randomUUID()}`, 404)
const vpatched = await expect('PATCH /vehicles/:id', 'PATCH', `/v1/vehicles/${v1}`, 200, { nickname: 'Smoke 2' })
check('nickname updated', vpatched?.nickname === 'Smoke 2')

// --- Documents ---
const [d1, d2, d3] = [randomUUID(), randomUUID(), randomUUID()]
const doc1 = await expect('POST doc (expiring soon) → 201', 'POST', `/v1/vehicles/${v1}/documents`, 201, {
  id: d1,
  type: 'insurance',
  expiryDate: addDays(today, 10),
})
check('doc1 status expiring_soon', doc1?.status === 'expiring_soon')
check('doc1 got profile default reminderDays', Array.isArray(doc1?.reminderDays))
const doc2 = await expect('POST doc (custom, valid) → 201', 'POST', `/v1/vehicles/${v1}/documents`, 201, {
  id: d2,
  type: 'custom',
  customName: 'Smoke permit',
  expiryDate: addDays(today, 100),
  reminderDays: [30, 7],
})
check('doc2 status valid', doc2?.status === 'valid')
const doc3 = await expect('POST doc (expired) → 201', 'POST', `/v1/vehicles/${v1}/documents`, 201, {
  id: d3,
  type: 'revenue_licence',
  expiryDate: addDays(today, -1),
})
check('doc3 status expired', doc3?.status === 'expired')
await expect('POST doc custom without name → 400', 'POST', `/v1/vehicles/${v1}/documents`, 400, {
  id: randomUUID(),
  type: 'custom',
  expiryDate: today,
})

const all = await expect('GET /documents?filter=all', 'GET', '/v1/documents?filter=all', 200)
check('all has d1, d2, d3', [d1, d2, d3].every((id) => ids(all?.documents).includes(id)))
const toRenew = await expect('GET /documents?filter=to_renew', 'GET', '/v1/documents?filter=to_renew', 200)
const tr = ids(toRenew?.documents)
check('to_renew has d1 + d3, not d2', tr.includes(d1) && tr.includes(d3) && !tr.includes(d2))
const valid = await expect('GET /documents?filter=valid', 'GET', '/v1/documents?filter=valid', 200)
const vl = ids(valid?.documents)
check('valid has d2, not d1/d3', vl.includes(d2) && !vl.includes(d1) && !vl.includes(d3))
await expect('GET /documents?filter=bad → 400', 'GET', '/v1/documents?filter=bad', 400)

const renewed = await expect('PATCH /documents/:id (Renew)', 'PATCH', `/v1/documents/${d1}`, 200, {
  expiryDate: addDays(today, 400),
})
check('renewed doc is valid', renewed?.status === 'valid' && renewed?.expiryDate === addDays(today, 400))
await expect('GET /documents/:id', 'GET', `/v1/documents/${d1}`, 200)

// --- Dashboard + upcoming reminders (embedded selects) ---
const dash = await expect('GET /dashboard', 'GET', '/v1/dashboard', 200)
check(
  'dashboard counts + upcoming',
  dash?.counts?.vehicles >= 1 && dash?.counts?.toRenew >= 1 && Array.isArray(dash?.upcoming),
)
check('upcoming has a vehicle summary', !!dash?.upcoming?.[0]?.vehicle?.plateNumber)
const upcoming = await expect('GET /reminders/upcoming', 'GET', '/v1/reminders/upcoming?limit=100', 200)
const mine = (upcoming?.reminders ?? []).filter((r) => [d1, d2].includes(r.documentId))
check('upcoming has reminders for d1/d2', mine.length > 0, `found ${mine.length}`)
check(
  'reminder has document + vehicle',
  mine.every((r) => r.document?.expiryDate && r.vehicle?.plateNumber),
)
check('d2 reminder at expiry-30', mine.some((r) => r.documentId === d2 && r.sendOn === addDays(today, 70)))
check('d1 old-expiry reminders gone after Renew', !mine.some((r) => r.documentId === d1 && r.sendOn < addDays(today, 10)))
await expect('GET /reminders/upcoming?limit=0 → 400', 'GET', '/v1/reminders/upcoming?limit=0', 400)

// --- Sync ---
const v2 = randomUUID()
const d4 = randomUUID()
const now = new Date()
const iso = (ms) => new Date(now.getTime() + ms).toISOString()
const syncVehicle = { id: v2, nickname: 'Synced', plateNumber: 'SYN-0001', type: 'van', updatedAt: iso(0) }
const syncDoc = {
  id: d4,
  vehicleId: v2,
  type: 'emission_test',
  expiryDate: addDays(today, 50),
  reminderDays: [7],
  pushEnabled: true,
  emailEnabled: false,
  updatedAt: iso(0),
}
const s1 = await expect('POST /sync push', 'POST', '/v1/sync', 200, {
  lastSyncedAt: null,
  changes: { vehicles: [syncVehicle], documents: [syncDoc] },
})
check('sync returns pushed rows', ids(s1?.vehicles).includes(v2) && ids(s1?.documents).includes(d4))
check('sync serverTime + rejected []', !!s1?.serverTime && s1?.rejected?.length === 0)

const s2 = await expect('POST /sync LWW loser + bad vehicle', 'POST', '/v1/sync', 200, {
  lastSyncedAt: s1?.serverTime ?? null,
  changes: {
    vehicles: [{ ...syncVehicle, nickname: 'Older edit', updatedAt: iso(-60_000) }],
    documents: [{ ...syncDoc, id: randomUUID(), vehicleId: randomUUID() }],
  },
})
check('older edit loses (winner returned)', s2?.vehicles?.find((v) => v.id === v2)?.nickname === 'Synced')
check('bad vehicle → vehicle_not_found', s2?.rejected?.[0]?.reason === 'vehicle_not_found')

const s3 = await expect('POST /sync delete vehicle', 'POST', '/v1/sync', 200, {
  lastSyncedAt: s2?.serverTime ?? null,
  changes: { vehicles: [{ ...syncVehicle, updatedAt: iso(1_000), deletedAt: iso(1_000) }], documents: [] },
})
check('sync delete cascades to doc', !!s3?.documents?.find((d) => d.id === d4)?.deletedAt)
await expect('POST /sync unknown field → 400', 'POST', '/v1/sync', 400, { lastSyncedAt: null, changes: {}, x: 1 })

// --- Devices ---
const pushToken = `ExponentPushToken[smoke-${randomUUID()}]`
const device = await expect('POST /devices', 'POST', '/v1/devices', 200, {
  pushToken,
  platform: 'android',
  deviceName: 'Smoke device',
})
check('device has no push token in response', device && !('pushToken' in device))
const dlist = await expect('GET /devices', 'GET', '/v1/devices', 200)
check('device listed', ids(dlist?.devices).includes(device?.id))
await expect('PATCH /devices/:id/seen', 'PATCH', `/v1/devices/${device?.id}/seen`, 200)
await expect('DELETE /devices/:id → 204', 'DELETE', `/v1/devices/${device?.id}`, 204)
await expect('DELETE /devices/:id again → 404', 'DELETE', `/v1/devices/${device?.id}`, 404)

// --- Cleanup (soft deletes) ---
await expect('DELETE /documents/:id → 204', 'DELETE', `/v1/documents/${d2}`, 204)
await expect('GET deleted document → 404', 'GET', `/v1/documents/${d2}`, 404)
await expect('DELETE /vehicles/:id → 204', 'DELETE', `/v1/vehicles/${v1}`, 204)
await expect('GET deleted vehicle → 404', 'GET', `/v1/vehicles/${v1}`, 404)
await expect('vehicle delete cascaded to d1', 'GET', `/v1/documents/${d1}`, 404)
await expect('PATCH /me theme back', 'PATCH', '/v1/me', 200, { theme: originalTheme })

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
// exitCode, not process.exit(): exiting right after fetch crashes Node on Windows (libuv assert).
process.exitCode = failures === 0 ? 0 : 1
