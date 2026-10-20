# Vehicle Doc Lanka — Backend

Hono API on Cloudflare Workers + Supabase for the Vehicle Doc Lanka mobile app, a "digital vehicle wallet". It stores **only expiry dates** of vehicle documents and reminds users before they expire. The app is local-first. This backend is used only after "Sign in to sync" (Google via Supabase Auth), to sync across devices and send push + email reminders.

**Stack:** Hono (TS) on Workers (`wrangler.jsonc`) · Supabase Postgres + Auth (backend only verifies JWTs) · `@supabase/supabase-js`, `zod` v4 + `@hono/zod-validator` · Cron Triggers, Rate Limiting bindings · Expo Push API, Resend · Vitest + `@cloudflare/vitest-plugin` · npm.

## Commands

- `npm run dev` (http://localhost:8787) · `npm run deploy` (dev Worker) · `npm run deploy:prod` (`production` env; the top-level config is dev)
- `npm run test` · `npx tsc --noEmit`
- `npm run cf-typegen`: regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` or secret names
- `npx hono request /v1/health src/app.ts`: call `app.request()` without a server. Run from PowerShell, because Git Bash rewrites the leading `/`.
- `npx hono search <q>` / `npx hono docs <path>`: current Hono docs. Use these instead of guessing APIs.
- Schema: `npx supabase migration new <name>` → `npx supabase db push` → `npx supabase gen types typescript --project-id <id> > src/types/db.ts` → run Security Advisor
- Cron locally: `npx wrangler dev --test-scheduled`, then GET `/__scheduled?cron=0+2+*+*+*`

After any change: typecheck, run tests, and hit the changed routes with `npx hono request`.

**Keep this file current and under 180 lines.** If a change adds or alters a convention, table, column, RPC, binding, route, command or folder, update the matching section in the same change. Write short lines, merge with existing points, and remove anything outdated, so this file always describes the code as it is.

## Folder structure

```
src/
  app.ts        # Hono app: global middleware, app.route() mounts (target for `hono request`)
  index.ts      # Worker entry: export default { fetch, scheduled }
  env.ts        # AppEnv = { Bindings, Variables: { user, supabase, requestId } }
  middleware/   # auth, rate-limit, logger
  routes/       # me, dashboard, vehicles, documents, reminders, sync, devices
  lib/          # supabase, errors, validator, status, dates, mappers, reminders, dashboard, push, email
  cron/         # send-reminders.ts
  schemas/      # zod schemas (json, query, params); shared primitives in common.ts
  types/db.ts   # generated, never edit by hand
supabase/migrations  # source of truth for the DB schema
test/helpers/        # test JWT/JWKS signing, Supabase fetch stub, setupHarness()
```

## Core rules (never break these)

1. **Privacy:** store only what the app shows. Documents = type, optional custom name, expiry date, reminder settings. Never add policy/chassis/engine numbers, owner names, NIC, photos or files.
2. **Status is computed, never stored** (`lib/status.ts`): `expired` if expiry < today, `expiring_soon` if within 30 days, else `valid`. "To renew" = expired + expiring soon.
3. **"Today" is Asia/Colombo**, not UTC. Always use `lib/dates.ts`.
4. **IDs are client-generated UUIDs** (offline creation). Upsert by `id`.
5. **Soft delete** vehicles/documents with `deleted_at`. Lists filter `deleted_at is null`.
6. **Never trust `user_id` from the client.** Always use `c.var.user.id`.
7. Routes use the **user-JWT Supabase client** so RLS applies. The service-role client is allowed only in `cron/` and `DELETE /v1/me`.
8. Any change to a document's expiry date, reminder days or channel toggles (including Renew) must call `rebuildReminders()`. A profile `pushEnabled`/`emailEnabled` change calls `rebuildAllReminders()`.
9. API JSON is camelCase, DB is snake_case. Map at the route boundary with `lib/mappers.ts`, never return raw rows, and never expose `user_id`.
10. Return `404` (not `403`) for rows that don't belong to the user.

## Database (Supabase)

- `profiles`: id (= auth user), display_name, reminder_email, push_enabled, email_enabled, default_reminder_days int[], theme, last_synced_at
- `vehicles`: id, user_id, nickname, plate_number, type (car | motorbike | three_wheeler | van), deleted_at
- `documents`: id, user_id, vehicle_id, type (revenue_licence | insurance | emission_test | registration | custom), custom_name, expiry_date, reminder_days int[], push_enabled, email_enabled, deleted_at
- `reminders`: id, user_id, document_id, days_before, send_on, channel (push | email), status (scheduled | sent | failed | skipped), sent_at, error; unique (document_id, days_before, channel, send_on), so a Renew gets fresh rows while sent history stays
- `devices`: id, user_id, push_token unique, platform (ios | android), device_name, last_seen_at
- All tables have `created_at` + `updated_at`. A trigger always sets `updated_at = now()`, so it is the trusted sync cursor.

RPCs (`security definer`):
- `register_device(p_push_token, p_platform, p_device_name)`: upserts a device by push token for `auth.uid()`, taking it over from another account. Used by `POST /v1/devices`.
- `rebuild_reminders(p_document_ids uuid[] default null)`: for the caller's docs (null = all live ones; foreign/missing ids skipped) deletes `scheduled` rows, then inserts the new ones with Colombo "today" and `on conflict do nothing`. Used by `lib/reminders.ts`.

Rules:
- RLS on every table: `user_id = (select auth.uid())` for using + with check (`id` for profiles). Users may only select `reminders`.
- A document's `vehicle_id` must be the same user's (composite FK + policy + code).
- `check` constraints match the zod limits. A trigger creates the `profiles` row on `auth.users` insert.
- When RLS blocks a write a route needs, add a `security definer` RPC instead of using the service role. It must `set search_path = ''`, take the user only from `auth.uid()`, `revoke execute ... from public, anon` and `grant ... to authenticated`.

## Request pipeline (`src/app.ts`)

`requestId()` → logger (JSON, no PII) → `secureHeaders()` → `bodyLimit` 100 KB (`/v1/sync` 1 MB) → `timeout(10_000)` → `auth` → `rateLimit` → routes with `validate()` → `app.onError` + `app.notFound`.

- No CORS (mobile only) and no CSRF (Bearer tokens, no cookies). `/v1/health` is the only public route. An unknown path without a valid token gets `401`, not `404`.
- **Auth** (`middleware/auth.ts`): Hono `jwk` with `SUPABASE_JWKS_URL`, `ES256`/`RS256` only. It checks `iss`, `aud = 'authenticated'`, `role = 'authenticated'`, `sub` and `exp`, else `401`. The token comes only from `Authorization: Bearer`. It sets `c.var.user = { id, email, sessionId }` and `c.var.supabase = userClient(env, token)`.
- **Rate limits**, keyed by user ID: `RATE_LIMITER` 100/min on all authed routes. `STRICT_RATE_LIMITER` 10/min via `strictRateLimit` on `/v1/sync`, `POST /v1/devices` and `DELETE /v1/me`.

## Validation, errors, logging

- Every json/query/param input goes through `validate()` (`lib/validator.ts`). Read input with `c.req.valid(...)`, never `c.req.json()`.
- Schemas use `.strict()`. Limits: nickname/customName ≤ 50, plate ≤ 15 (trim + uppercase, `^[A-Z0-9 -]+$`), reminderDays ≤ 6 unique in 1..365, `:id` is a UUID, dates are `YYYY-MM-DD`.
- Error shape: `{ "error": { "code", "message", "requestId" } }`. A `validation_failed` (400) error adds `details: [{ path, message }]`, never input values.
- Throw the helpers in `lib/errors.ts` (`notFound()`, `badRequest()`, `conflict()`, ...). For Supabase errors, `throw dbError(error)` gives a generic 500.
- Never send stack traces, SQL or Supabase messages to clients; log them server-side with the request ID. Never log tokens, Authorization, bodies, emails, plates or push tokens.

## API (`/v1`)

- `GET /health` (public)
- `GET | PATCH | DELETE /me`: profile + settings. DELETE removes the auth user, and the FKs cascade to all data.
- `GET /dashboard`: `{ counts: { vehicles, documents, toRenew }, upcoming }`. Only live docs on live vehicles count. `upcoming` = 5 soonest `expiry_date` (expired first; ties by created_at, id), each `toDocument` + `vehicle` summary. Logic in `lib/dashboard.ts`.
- `GET | POST /vehicles`, `GET | PATCH | DELETE /vehicles/:id`
- `GET /documents?filter=all|to_renew|valid`, `POST /vehicles/:id/documents`, `GET | PATCH | DELETE /documents/:id` (PATCH with a new expiryDate = Renew)
- `GET /reminders/upcoming?limit=1..100` (default 50): `scheduled`, `send_on >= today`, live doc + vehicle (embedded `!inner` select), by send_on, id. Each `toReminder` + `document` + `vehicle` summary.
- `POST /sync`
- `GET | POST /devices`, `PATCH /devices/:id/seen`, `DELETE /devices/:id`
- Status codes: 200, 201, 204, 400, 401, 404, 409, 413, 429, 500.

Route conventions:
- Lists wrap the array (`{ vehicles: [...] }`). Deleted, missing and foreign rows all give `404`: `.eq('id', id).is('deleted_at', null).maybeSingle()`, and null data → `notFound()`.
- **Client-id upsert** (`POST /vehicles`, `POST /vehicles/:id/documents`): `upsert(row, { onConflict: 'id', ignoreDuplicates: true })` → `201`. If nothing comes back, update the user's own live row by id → `200`. If that also matches nothing → `409` "This id is already in use" (the same for foreign and own-deleted ids, so the owner never leaks). POST is a full representation: omitted optional fields reset to defaults (reminderDays → the profile's `default_reminder_days`).
- `POST /vehicles/:id/documents` needs a live vehicle owned by the user, else `404`. `customName` is required iff `type = custom` (checked on the merged row for PATCH). Switching away from `custom` clears it.
- `DELETE /vehicles/:id` soft-deletes its live documents first (rebuilding reminders for each), then the vehicle, with one `deleted_at`.
- Document PATCH calls `rebuildReminders()` only if `remindersChanged(old, new)`. Create, upsert-update and delete always call it.

## Sync (`POST /v1/sync`)

Body: `{ lastSyncedAt | null, changes: { vehicles[], documents[] } }`.
1. Validate. Cap rows (≤ 500). Reject `updatedAt` more than 5 min in the future.
2. Upsert vehicles, then documents, by `id`. Last write wins on `updatedAt`.
3. Set `user_id` server-side. Reject ids owned by another user. vehicleId must be the user's.
4. Rebuild reminders for changed documents.
5. Return rows (including soft-deleted) with `updated_at > lastSyncedAt`, plus `serverTime`. Save `last_synced_at`.

## Reminders

- Rows: one per (reminder day × channel on in **both** profile and document), `send_on = expiry_date - days`, skipping `send_on < today` (today itself is kept). A deleted doc gets none. No expiry-day row (`days_before = 0` is unused, since reminderDays are 1..365).
- **The SQL `rebuild_reminders` RPC is the source of truth**: it reads the doc and profile itself, so it never trusts rows from the client. `buildReminderRows(doc, profile, today)` is a pure TS mirror for tests and later phases. Change both together.
- `lib/reminders.ts`: `rebuildReminders(client, doc)` → RPC with `[doc.id]`; `rebuildAllReminders(client)` → RPC for all live docs; `remindersChanged(before, after)` is the pure change check. RPC errors → `dbError`.
- Daily cron `0 2 * * *` (07:30 Colombo) uses the service-role client and is not an HTTP route. It picks `status = 'scheduled' and send_on <= today` and marks reminders for deleted docs `skipped`. It pushes to **all** of a user's devices when profile + document push are on, and deletes `DeviceNotRegistered` tokens. It sends one email per user (with user text HTML-escaped) and marks rows `sent`/`failed`. It works in batches of 100, is safe to re-run, and one user's failure doesn't stop the others.
- Message: `Insurance · CAB-1234 expires in 5 days (24 Oct 2026)`.

## Hono conventions

- No controller classes. Use inline handlers so params and inputs are typed; use `createFactory<AppEnv>()` if a handler must be separate.
- Each route file exports `new Hono<AppEnv>()`, mounted with `app.route()`.
- Secrets come from `c.env`, never `process.env`. Supabase clients are created per request.
- Run background work via `c.executionCtx.waitUntil()`, never as unawaited promises. Business logic lives in `lib/` so it can be unit tested. No `any`.

## Secrets and config

- Secrets: `wrangler secret put` (prod) and `.dev.vars` (local, gitignored): `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EXPO_ACCESS_TOKEN`.
- Vars in `wrangler.jsonc`: `ENVIRONMENT`, `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `EMAIL_FROM`, plus `triggers.crons` and `ratelimits`. Dev and prod use separate Supabase projects.

## Testing

- Tests never hit live Supabase or the real JWKS. Route tests use `setupHarness()` (`test/helpers/api.ts`): local signed tokens, fake rate limiters and a Supabase fetch stub.
- Spy on `rebuildReminders` with `vi.mock('../src/lib/reminders', ...)`, keeping the real exports via `importOriginal`.
- Must cover: Colombo vs UTC dates, status boundaries, rebuildReminders, bad tokens → 401, user B → 404 on user A's rows, unknown fields/oversized/bad UUID → 400/413, sync conflict rules, and cron re-runs not resending.

## Out of scope (v1)

Per-device session revocation, document photos/files, sharing vehicles, SMS, web client.
