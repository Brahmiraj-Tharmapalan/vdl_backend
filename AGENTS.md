# Vehicle Doc Lanka — Backend

Hono API on Cloudflare Workers + Supabase for the Vehicle Doc Lanka mobile app: a "digital vehicle wallet" that stores **only expiry dates** of vehicle documents and reminds users before they expire.

The app is local-first. Users without an account keep data on the phone (local notifications). This backend is used only after "Sign in to sync" (Google via Supabase Auth): it syncs data across devices and sends push + email reminders.

## Stack

- Hono (TypeScript) on Cloudflare Workers, config in `wrangler.jsonc`
- Supabase Postgres + Supabase Auth (Google); backend only verifies JWTs
- `@supabase/supabase-js`, `zod` + `@hono/zod-validator`
- Cloudflare Cron Triggers (reminders), Rate Limiting binding
- Expo Push API (push), Resend (email)
- Vitest + `@cloudflare/vitest-plugin` (renamed from `@cloudflare/vitest-pool-workers`)

## Commands

- `npm run dev` — local server on http://localhost:8787
- `npm run deploy` — deploy the dev Worker to Cloudflare
- `npm run test` — tests; `npx tsc --noEmit` — typecheck
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` or secret names
- `npm run deploy:prod` — deploy the `production` env (top-level config is dev)
- `npx hono request /v1/health src/app.ts` — send a request via `app.request()` without a server (run from PowerShell; Git Bash rewrites the leading `/`)
- `npx hono search <query>` / `npx hono docs <path>` — read current Hono docs; use these instead of guessing APIs
- `npx supabase migration new <name>` then `npx supabase db push` — schema changes
- `npx supabase gen types typescript --project-id <id> > src/types/db.ts`
- Test cron locally: `npx wrangler dev --test-scheduled`, then GET `/__scheduled?cron=0+2+*+*+*`

After any change: typecheck, run tests, and hit the changed routes with `npx hono request`.

**Keep this file current.** If a change adds or alters a convention, table, column, RPC, binding, route, command or folder, update the matching section of this file in the same change. This file must always describe the code as it is.

## Folder structure

```
src/
  app.ts            # Hono app: global middleware, app.route() mounts (target for `hono request`)
  index.ts          # Worker entry: export default { fetch, scheduled }
  env.ts            # AppEnv = { Bindings, Variables: { user, supabase, requestId } }
  middleware/       # auth.ts, rate-limit.ts, logger.ts
  routes/           # me, dashboard, vehicles, documents, reminders, sync, devices
  lib/              # supabase, errors, validator, status, dates, mappers, reminders, push, email
  cron/             # send-reminders.ts
  schemas/          # zod schemas (json, query, params)
  types/db.ts       # generated, never edit by hand
supabase/migrations # the source of truth for the DB schema
test/
  helpers/          # test JWT/JWKS signing, Supabase stubs, request helpers
```

## Core rules (never break these)

1. **Privacy:** store only what the app shows. Documents = type, optional custom name, expiry date, reminder settings. Never add policy numbers, chassis/engine numbers, owner names, NIC, photos or file uploads.
2. **Status is computed, never stored** (`lib/status.ts`): `expired` if expiry < today; `expiring_soon` if within 30 days; else `valid`. "To renew" = expired + expiring soon.
3. **"Today" is Asia/Colombo**, not UTC. Always use `lib/dates.ts`.
4. **IDs are client-generated UUIDs** (offline creation). Upsert by `id`.
5. **Soft delete** vehicles/documents with `deleted_at`; lists filter `deleted_at is null`.
6. **Never trust `user_id` from the client.** Always use `c.var.user.id`.
7. Routes use the **user-JWT Supabase client** so RLS applies. The service-role client is allowed only in `cron/` and `DELETE /v1/me`.
8. Any change to a document's expiry date, reminder days or channel toggles (including Renew) must call `rebuildReminders()`.
9. API JSON is camelCase, DB is snake_case. Map at the route boundary; never return raw rows.
10. Return `404` (not `403`) for rows that don't belong to the user.

## Database (Supabase)

Tables (full SQL in `supabase/migrations/`):

- `profiles` — id (= auth user), display_name, reminder_email, push_enabled, email_enabled, default_reminder_days int[], theme, last_synced_at
- `vehicles` — id, user_id, nickname, plate_number, type (car | motorbike | three_wheeler | van), timestamps, deleted_at
- `documents` — id, user_id, vehicle_id, type (revenue_licence | insurance | emission_test | registration | custom), custom_name, expiry_date, reminder_days int[], push_enabled, email_enabled, timestamps, deleted_at
- `reminders` — id, user_id, document_id, days_before, send_on, channel (push | email), status (scheduled | sent | failed | skipped), sent_at, error; unique (document_id, days_before, channel)
- `devices` — id, user_id, push_token unique, platform (ios | android), device_name, last_seen_at

All tables have `created_at` + `updated_at`. A trigger always sets `updated_at = now()` (server time), so it is the trusted sync cursor.

RPCs (`security definer` functions):
- `register_device(p_push_token, p_platform, p_device_name)` — upserts a device by push token for `auth.uid()`, taking it over from another account (a phone that switched users). Used by `POST /v1/devices`.

DB rules:
- RLS on every table: `user_id = (select auth.uid())` for using + with check (`id` for profiles).
- A document's `vehicle_id` must belong to the same user (policy + code).
- Users may only select `reminders`; writes go through code.
- Add length/enum `check` constraints matching the zod schemas.
- Trigger: create `profiles` row on `auth.users` insert (`security definer`, `set search_path = ''`).
- When RLS blocks a write a route needs (e.g. a row owned by another user, or a table users can't write), add a `security definer` RPC instead of using the service-role client. It must `set search_path = ''`, take the user only from `auth.uid()` (never a parameter), and `revoke execute ... from public, anon` then `grant execute ... to authenticated`.
- A migration is applied with `npx supabase db push`, then regenerate `src/types/db.ts`.
- Run Supabase Security Advisor after every migration.

## Middleware order (`src/app.ts`)

1. `requestId()` → 2. logger (JSON, no PII) → 3. `secureHeaders()` → 4. `bodyLimit` 100 KB (`/v1/sync` 1 MB) → 5. `timeout(10_000)` → 6. `auth` → 7. `rateLimit` → 8. routes with `validate()` → 9. `app.onError` + `app.notFound`.

- No CORS (mobile only). No CSRF middleware (Bearer tokens, no cookies).
- `/health` is the only public route. Auth runs before `notFound`, so an unknown path without a valid token gets `401`, not `404` (no route probing).

## Auth (`middleware/auth.ts`)

- Verify with Hono's `jwk` middleware using `SUPABASE_JWKS_URL`; allow only `ES256`/`RS256`.
- Then check `iss === SUPABASE_JWT_ISSUER`, `aud === 'authenticated'`, `role === 'authenticated'`, `sub` present. Otherwise `401`.
- Token only from the `Authorization: Bearer` header, never query strings.
- Set `c.var.user = { id: sub, email, sessionId }` and `c.var.supabase = userClient(env, token)`.

## Validation, errors, logging

- Every json/query/param input goes through `validate()` (zod wrapper in `lib/validator.ts`). Read input with `c.req.valid(...)`, never `c.req.json()`.
- Schemas use `.strict()` and limits: nickname/customName ≤ 50, plate ≤ 15 (trim + uppercase, `^[A-Z0-9 -]+$`), reminderDays ≤ 6 items in 1..365, `:id` is UUID, dates are `YYYY-MM-DD`.
- Error shape: `{ "error": { "code", "message", "requestId" } }`. Validation failures (`code: "validation_failed"`, 400) also have `details: [{ path, message }]`, never the input values.
- For expected errors throw the helpers in `lib/errors.ts` (`notFound()`, `badRequest()`, `conflict()`, ... — `ApiError` extends `HTTPException`). `app.onError` maps everything through `toErrorResponse()`.
- Supabase errors: `throw dbError(error)` (`lib/supabase.ts`). The client gets a generic 500; the message is logged server-side.
- Never send stack traces, SQL or Supabase messages to clients. Log them server-side with the request ID.
- Never log tokens, Authorization headers, bodies, emails, plate numbers or push tokens.

## Rate limiting

- `RATE_LIMITER` binding, keyed by user ID (not IP): 100/min.
- `STRICT_RATE_LIMITER` binding (10/min) for `/v1/sync`, `POST /v1/devices`, `DELETE /v1/me`: add `strictRateLimit` from `middleware/rate-limit.ts` to those routes.

## API (`/v1`, all behind auth)

- `GET /health` (public)
- `GET | PATCH | DELETE /me` — profile + settings; delete removes all synced data and the auth user
- `GET /dashboard` — counts (vehicles, documents, toRenew) + top 5 upcoming
- `GET | POST /vehicles`, `GET | PATCH | DELETE /vehicles/:id`
- `GET /documents?filter=all|to_renew|valid`, `POST /vehicles/:id/documents`, `GET | PATCH | DELETE /documents/:id` (PATCH with new expiryDate = Renew)
- `GET /reminders/upcoming`
- `POST /sync`
- `GET | POST /devices`, `PATCH /devices/:id/seen`, `DELETE /devices/:id`

Status codes: 200, 201, 204, 400, 401, 404, 409, 413, 429, 500.

Route conventions:
- Lists wrap the array: `{ vehicles: [...] }`, `{ documents: [...] }`, `{ devices: [...] }`. Lists and `/:id` routes filter `deleted_at is null`; deleted, missing and foreign rows all give `404`.
- "Not mine → 404": `.update/.delete/.select(...).eq('id', id).is('deleted_at', null).maybeSingle()`; null data → `notFound()`.
- **Client-id upsert** (`POST /vehicles`, `POST /vehicles/:id/documents`): insert with `upsert(row, { onConflict: 'id', ignoreDuplicates: true })` (on conflict do nothing, which only checks the INSERT policy) → `201`; if nothing comes back, update the user's own live row by `id` (documents also need `vehicle_id = :id`) → `200`; if that matches nothing too, the id is another account's or the user's soft-deleted row → `409 conflict` "This id is already in use" (same message for both, so the owner never leaks). POST is a full representation: omitted optional fields reset to defaults (nickname → null, reminderDays → profile `default_reminder_days`, toggles → true).
- `POST /vehicles/:id/documents`: the vehicle must be the user's and live, else `404`.
- `customName` is required iff `type = custom`. PATCH checks this on the merged row (400 `validation_failed`, path `customName`); switching `type` away from `custom` clears `custom_name`.
- `DELETE /vehicles/:id`: check the vehicle is live (else 404), soft-delete its live documents (rebuilding reminders for each), then the vehicle, with one `deleted_at`. Documents go first so a retry never leaves live documents under a deleted vehicle.
- Document PATCH calls `rebuildReminders()` only when `remindersChanged(old, new)` (expiry, reminder days, push/email toggles, deleted_at); create, upsert-update and delete always call it.

## Sync (`POST /v1/sync`)

Body: `{ lastSyncedAt | null, changes: { vehicles[], documents[] } }`.
1. Validate; cap rows (≤ 500); reject `updatedAt` more than 5 min in the future.
2. Upsert vehicles then documents by `id`; last write wins on `updatedAt`.
3. Set `user_id` server-side; reject ids owned by another user; vehicleId must be the user's.
4. Rebuild reminders for changed documents.
5. Return rows (incl. soft-deleted) with `updated_at > lastSyncedAt` + `serverTime`; save `last_synced_at`.

## Reminders

- `lib/reminders.ts`: `rebuildReminders(client, doc)` is currently a **no-op stub** (P6 fills it via a `security definer` RPC, since users can only select `reminders`); `remindersChanged(before, after)` is the pure change check.
- `rebuildReminders(doc)`: delete its `scheduled` rows; if not deleted, create one row per (days, enabled channel) with `send_on = expiry_date - days`, skipping dates before today.
- Daily cron `0 2 * * *` (07:30 Colombo), service-role client, not an HTTP route:
  - pick `status = 'scheduled' and send_on <= today`; deleted docs → `skipped`
  - push to **all** user devices if profile + document push are on; delete `DeviceNotRegistered` tokens
  - one email per user listing all due documents; escape user text in HTML
  - mark `sent`/`failed`; safe to re-run; batches of 100; one user's failure doesn't stop others
- Message: `Insurance · CAB-1234 expires in 5 days (24 Oct 2026)`.

## Hono conventions

- No controller classes; inline handlers so params/inputs are typed. Use `createFactory<AppEnv>()` if a handler must be separate.
- Each route file exports `new Hono<AppEnv>()`, mounted with `app.route()`.
- Secrets via `c.env`, never `process.env`. Supabase clients are created per request.
- Background work via `c.executionCtx.waitUntil()`, never unawaited promises.
- Business logic lives in `lib/` so it can be unit tested. No `any`.

## Secrets and config

- Secrets: `wrangler secret put` (prod), `.dev.vars` (local, gitignored): `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EXPO_ACCESS_TOKEN`.
- Vars in `wrangler.jsonc`: `ENVIRONMENT`, `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `EMAIL_FROM`; plus `triggers.crons` and `ratelimits`.
- Separate Supabase projects for dev and prod.

## Testing requirements

- Tests never hit the live Supabase project or real JWKS: sign tokens with the local keys and stub Supabase using the helpers in `test/helpers/`.
- Route tests use `setupHarness()` from `test/helpers/api.ts`; spy on `rebuildReminders` with `vi.mock('../src/lib/reminders', ...)` keeping the real exports via `importOriginal`.
- Unit: status, dates (Colombo vs UTC midnight, month ends), rebuildReminders.
- Auth: missing/expired/wrong-issuer/wrong-alg token → 401.
- Isolation: user B gets 404 on user A's vehicles, documents and devices.
- Validation: unknown fields, oversized input, bad UUIDs → 400/413.
- Sync: older row ignored, future `updatedAt` rejected, soft deletes returned, foreign ids rejected.
- Cron: re-run doesn't resend; dead push tokens removed.

## Out of scope (v1)

Per-device session revocation, document photos/files, sharing vehicles, SMS, web client.