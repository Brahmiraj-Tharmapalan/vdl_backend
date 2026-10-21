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
- Cron locally: `npx wrangler dev --test-scheduled`, then GET `/__scheduled?cron=0+2+*+*+*` (sends real pushes/emails for due rows)
- Live smoke test: `npm run dev-token` (a dev email/password test user from `SMOKE_EMAIL`/`SMOKE_PASSWORD` → gitignored `.smoke-token`), then `npm run smoke` (every route, plus a direct Data API call that must get 401/403 from the gateway; `BASE_URL` defaults to localhost:8787; for prod also set `SUPABASE_URL`/`SUPABASE_ANON_KEY`; soft-deletes what it creates)
- Windows: stopping wrangler can leave `workerd.exe` running with old secrets, and a new `npm run dev` then moves to the next port. Kill it before restarting after editing `.dev.vars`.

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
  lib/          # supabase, jwks, errors, validator, status, dates, mappers, reminders, reminder-message, dashboard, sync, push, email
  cron/         # send-reminders.ts
  schemas/      # zod schemas (json, query, params); shared primitives in common.ts
  types/db.ts   # generated, never edit by hand
supabase/migrations  # source of truth for the DB schema (supabase/tests: SQL smoke tests)
test/helpers/        # test JWT/JWKS signing, Supabase fetch stub, setupHarness(); cron.ts: cron fakes
scripts/             # dev-token.mjs, smoke.mjs (live smoke test, not part of `npm run test`)
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
- `vehicles`: id, user_id, nickname, plate_number, type (car | motorbike | three_wheeler | van), client_updated_at, deleted_at
- `documents`: id, user_id, vehicle_id, type (revenue_licence | insurance | emission_test | registration | custom), custom_name, expiry_date, reminder_days int[], push_enabled, email_enabled, client_updated_at, deleted_at
- `reminders`: id, user_id, document_id, days_before, send_on, channel (push | email), status (scheduled | sending | sent | failed | skipped), sent_at, error (short code), claimed_at; unique (document_id, days_before, channel, send_on), so a Renew gets fresh rows while sent history stays
- `devices`: id, user_id, push_token unique (Expo format `ExponentPushToken[...]` / `ExpoPushToken[...]`, CHECK + zod), platform (ios | android), device_name, last_seen_at
- All tables have `created_at` + `updated_at`. A trigger always sets `updated_at = now()`, so it is the trusted sync cursor.
- `client_updated_at` (vehicles, documents) is the client's `updatedAt`, used only for last-write-wins and never exposed. Sync sets it. An update that leaves it unchanged (every REST write) gets `now()` from a trigger.

RPCs (`security definer`):
- `register_device(p_push_token, p_platform, p_device_name)`: upserts a device by push token for `auth.uid()`, taking it over from another account, and keeps ≤ 10 devices per user (evicts the least recently seen). Used by `POST /v1/devices`.
- `rebuild_reminders(p_document_ids uuid[] default null)`: for the caller's docs (null = all live ones; foreign/missing ids skipped) deletes `scheduled` rows, then inserts the new ones with Colombo "today" and `on conflict do nothing`. Used by `lib/reminders.ts`.
- `sync_changes(p_last_synced_at default null, p_vehicles jsonb, p_documents jsonb)`: the whole sync push + pull in one transaction (see Sync). Rejects > 500 rows per array (22023), then calls the internal `sync_changes_unchecked` (no grants). It bypasses RLS, so every statement filters by `auth.uid()`. Smoke test: `npx supabase db query --linked --yes -f supabase/tests/sync_smoke.sql` (rolled back).
- Cron only (execute granted to `service_role` alone): `claim_due_reminders(p_today, p_limit)` first fails `sending` rows claimed > 1 h ago (`interrupted`), then sets all due `scheduled` rows of `p_limit` users (oldest due `send_on` first, ties by a daily md5 hash, never by user_id) to `sending` and returns them joined with doc/vehicle/profile (`reminder_email` only if the auth email is confirmed, else null → `no_email`). `finish_reminders(p_results jsonb)` sets `sending` rows to sent/failed/skipped, or back to `scheduled` (never attempted). Smoke test: `supabase/tests/cron_smoke.sql`. `supabase/tests/harden_smoke.sql` covers the hardening rules below.

Rules:
- RLS on every table: `user_id = (select auth.uid())` for using + with check (`id` for profiles). Users may only select `reminders`.
- A document's `vehicle_id` must be the same user's (composite FK + policy + code).
- `check` constraints match the zod limits. A trigger creates the `profiles` row on `auth.users` insert.
- **Data API gateway:** PostgREST's pre-request `private.check_gateway()` rejects (42501) every REST/RPC/GraphQL request without header `x-vdl-gateway` = the Worker's `GATEWAY_KEY` (only its sha256 is stored, in `private.gateway_key`; fails closed until set). `service_role` is exempt. Supabase Auth isn't affected. Smoke test: `supabase/tests/gateway_smoke.sql`.
- Defense in depth, in case the Data API is reached directly anyway, the DB enforces every rule itself, not just the Worker:
  - Quotas (`enforce_user_quota` trigger, SQLSTATE `VDL01` → `dbError` → 409 `limit_reached`): vehicles 50 live / 500 total, documents 300 live / 3000 total. Upserts of existing ids don't count.
  - Column-level grants: users write only the columns the routes write (no `client_updated_at`, `created_at`, `last_synced_at`, `user_id` updates; no direct device inserts). Add a column to a grant when a route starts writing it.
  - `client_updated_at` is clamped to ≤ now() + 5 min. A soft-deleted vehicle/document can't be updated (`keep_deleted` skips it). `reminder_email` must be the auth user's **confirmed** email (trigger, case-insensitive). It is set at sign-up only if the email is already confirmed (Google), else when it gets confirmed (`on_auth_user_email_confirmed`).
- When RLS blocks a write a route needs, add a `security definer` RPC instead of using the service role. It must `set search_path = ''`, take the user only from `auth.uid()`, `revoke execute ... from public, anon` and `grant ... to authenticated`.

## Request pipeline (`src/app.ts`)

`requestId()` (always server-generated; client `X-Request-Id` ignored) → logger (JSON, no PII) → `secureHeaders()` → `Cache-Control: no-store` → `bodyLimit` 100 KB (`/v1/sync` 1 MB) → `timeout(10_000)` → `auth` → `rateLimit` → `writeRateLimit` → routes with `validate()` → `app.onError` + `app.notFound`.

- No CORS (mobile only) and no CSRF (Bearer tokens, no cookies). `/v1/health` is the only public route. An unknown path without a valid token gets `401`, not `404`.
- **Auth** (`middleware/auth.ts`): Hono `jwk` with `keys` from `lib/jwks.ts` (in-memory JWKS cache: 10 min TTL, an unknown `kid` refetches at most once/min, stale keys kept if a refetch fails; never `jwks_uri`, which fetches per request), `ES256`/`RS256` only. It checks `iss`, `aud = 'authenticated'`, `role = 'authenticated'`, `sub` and `exp`, and rejects anonymous users (`is_anonymous: true`), else `401`. The token comes only from `Authorization: Bearer`. It sets `c.var.user = { id, email, sessionId, signedInAt }` (`signedInAt` = latest `amr` timestamp, which survives refreshes, unlike `iat`) and `c.var.supabase = userClient(env, token)`.
- **Rate limits**, keyed by user ID: `RATE_LIMITER` 100/min on all authed routes. `WRITE_RATE_LIMITER` 30/min on every non-GET. `STRICT_RATE_LIMITER` 10/min via `strictRateLimit` on `/v1/sync`, `POST /v1/devices`, `PATCH /v1/me` (a toggle rebuilds all reminders) and `DELETE /v1/me`. Unauthenticated traffic is only limited by the Cloudflare WAF (prod).

## Validation, errors, logging

- Every json/query/param input goes through `validate()` (`lib/validator.ts`). Read input with `c.req.valid(...)`, never `c.req.json()`.
- Schemas use `.strict()`. Limits: nickname/customName ≤ 50, plate ≤ 15 (trim + uppercase, `^[A-Z0-9 -]+$`), reminderDays ≤ 6 unique in 1..365, `:id` is a UUID, dates are `YYYY-MM-DD`.
- Error shape: `{ "error": { "code", "message", "requestId" } }`. A `validation_failed` (400) error adds `details: [{ path, message }]`, never input values.
- Throw the helpers in `lib/errors.ts` (`notFound()`, `badRequest()`, `conflict()`, ...). For Supabase errors, `throw dbError(error)` gives a generic 500.
- Never send stack traces, SQL or Supabase messages to clients; log them server-side with the request ID. Never log tokens, Authorization, bodies, emails, plates or push tokens.

## API (`/v1`)

- `GET /health` (public)
- `GET | PATCH | DELETE /me`: profile + settings. `reminderEmail` must be the confirmed sign-in email or null (else 400), so reminders can't be sent to strangers. DELETE needs a sign-in ≤ 10 min old (else 403 `reauth_required`: the app re-signs in), then removes the auth user, and the FKs cascade to all data.
- `GET /dashboard`: `{ counts: { vehicles, documents, toRenew }, upcoming }`. Only live docs on live vehicles count. `upcoming` = 5 soonest `expiry_date` (expired first; ties by created_at, id), each `toDocument` + `vehicle` summary. Logic in `lib/dashboard.ts`.
- `GET | POST /vehicles`, `GET | PATCH | DELETE /vehicles/:id`
- `GET /documents?filter=all|to_renew|valid`, `POST /vehicles/:id/documents`, `GET | PATCH | DELETE /documents/:id` (PATCH with a new expiryDate = Renew)
- `GET /reminders/upcoming?limit=1..100` (default 50): `scheduled`, `send_on >= today`, live doc + vehicle (embedded `!inner` select), by send_on, id. Each `toReminder` + `document` + `vehicle` summary.
- `POST /sync`: see Sync
- `GET | POST /devices`, `PATCH /devices/:id/seen`, `DELETE /devices/:id`
- Status codes: 200, 201, 204, 400, 401, 403 (only `reauth_required`), 404, 409 (incl. `limit_reached`), 413, 429, 500, 504 (`timeout`).

Route conventions:
- Lists wrap the array (`{ vehicles: [...] }`). Deleted, missing and foreign rows all give `404`: `.eq('id', id).is('deleted_at', null).maybeSingle()`, and null data → `notFound()`.
- **Client-id upsert** (`POST /vehicles`, `POST /vehicles/:id/documents`): `upsert(row, { onConflict: 'id', ignoreDuplicates: true })` → `201`. If nothing comes back, update the user's own live row by id → `200`. If that also matches nothing → `409` "This id is already in use" (the same for foreign and own-deleted ids, so the owner never leaks). POST is a full representation: omitted optional fields reset to defaults (reminderDays → the profile's `default_reminder_days`).
- `POST /vehicles/:id/documents` needs a live vehicle owned by the user, else `404`. `customName` is required iff `type = custom` (checked on the merged row for PATCH). Switching away from `custom` clears it.
- `DELETE /vehicles/:id` soft-deletes its live documents first (rebuilding reminders for each), then the vehicle, with one `deleted_at`.
- Document PATCH calls `rebuildReminders()` only if `remindersChanged(old, new)`. Create, upsert-update and delete always call it.

## Sync (`POST /v1/sync`)

Body: `{ lastSyncedAt | null, changes: { vehicles[], documents[] } }`. Rows are full local representations with `updatedAt` and `deletedAt`. Response: `{ serverTime, vehicles, documents, rejected }`.
1. zod (`schemas/sync.ts`): ≤ 500 rows per array, unique ids, `updatedAt`/`deletedAt` ≤ 5 min in the future, else `400`.
2. One `sync_changes` RPC call does the rest atomically, vehicles before documents. `user_id` comes from `auth.uid()`.
3. Merge: last write wins on `client_updated_at`, and a **delete always wins**. A server-deleted row never changes again. `shouldApply()` in `lib/sync.ts` is the TS mirror; change both together.
4. Per-row `rejected: [{ entity, id, reason }]`, never a 409: `id_in_use` (another account's id) or `vehicle_not_found` (the doc's vehicle isn't the user's, or is deleted while the doc is live).
5. A vehicle deleted via sync soft-deletes its live docs (same `deleted_at`). Reminders are rebuilt for all changed docs. `last_synced_at = now()`.
6. Pull: rows (soft-deleted included) with `updated_at > lastSyncedAt` (null = all), plus every pushed non-rejected id, so a losing edit gets the winner back.
7. `serverTime` = the next `lastSyncedAt` = `now() - 60 s`, so a concurrent transaction that commits later can't be missed. Re-delivery is idempotent.

## Reminders

- Rows: one per (reminder day × channel on in **both** profile and document), `send_on = expiry_date - days`, skipping `send_on < today` (today itself is kept). A deleted doc gets none. No expiry-day row (`days_before = 0` is unused, since reminderDays are 1..365).
- **The SQL `rebuild_reminders` RPC is the source of truth**: it reads the doc and profile itself, so it never trusts rows from the client. `buildReminderRows(doc, profile, today)` is a pure TS mirror for tests. Change both together.
- `lib/reminders.ts`: `rebuildReminders(client, doc)` → RPC with `[doc.id]`; `rebuildAllReminders(client)` → RPC for all live docs; `remindersChanged(before, after)` is the pure change check. RPC errors → `dbError`.
- Daily cron `0 2 * * *` (07:30 Colombo, today from `scheduledTime`) in `cron/send-reminders.ts`, via `ctx.waitUntil`; service-role client, not an HTTP route. **At-most-once**: claim → send → finish, so a re-run or crash never resends.
- Send-time decisions (`planDelivery` in `lib/reminder-message.ts`, pure): `skipped` with `document_deleted` (doc or vehicle), `push_off`/`email_off` (profile or doc), `no_email`, `no_devices`, `superseded` (several due rows per doc + channel: only the smallest days_before is sent).
- Push (`lib/push.ts`): **one push per user** per run (all due docs: `… and 2 more`; `data.documentId` only for a single doc), Expo, ≤ 100 messages per request, to **all** the user's devices; sent if any ticket is ok. `DeviceNotRegistered` tokens are deleted. Push receipts are not checked (out of scope).
- Email (`lib/email.ts`): one per user to `reminder_email`, HTML (user text escaped) + text, via Resend `/emails/batch`; a 400/422 batch is retried one by one so a bad address fails only its user.
- Stored errors are codes only (`expo_<code|status>`, `resend_<status>`), never provider text, tokens or emails. Logs: one JSON summary line of counts.
- Workers Free: `SUBREQUEST_BUDGET = 45` per run (~5 per batch of `BATCH_SIZE = 50` users; a user costs ≤ 10 pushes + 1 email however many rows are due). Rows beyond it are released or left `scheduled` for the next run.
- Message: `Insurance · CAB-1234 expires in 5 days (24 Oct 2026)`; also `in 1 day`, `today`, `expired`.

## Hono conventions

- No controller classes. Use inline handlers so params and inputs are typed; use `createFactory<AppEnv>()` if a handler must be separate.
- Each route file exports `new Hono<AppEnv>()`, mounted with `app.route()`.
- Secrets come from `c.env`, never `process.env`. Supabase clients are created per request.
- Run background work via `c.executionCtx.waitUntil()`, never as unawaited promises. Business logic lives in `lib/` so it can be unit tested. No `any`.

## Secrets and config

- Secrets: `wrangler secret put` (prod) and `.dev.vars` (local, gitignored): `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EXPO_ACCESS_TOKEN`, `GATEWAY_KEY` (random, ≥ 32 bytes; its sha256 goes in that project's `private.gateway_key`).
- Vars in `wrangler.jsonc`: `ENVIRONMENT`, `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `EMAIL_FROM`, plus `triggers.crons` and `ratelimits`. Dev and prod use separate Supabase projects.
- Dev `EMAIL_FROM` is Resend's `onboarding@resend.dev`, which only delivers to the Resend account's own email and lands in Gmail spam. Prod needs a verified Resend domain (SPF + DKIM, plus a DMARC record).
- Supabase keys: legacy `anon` + `service_role` JWTs (or `sb_publishable_` + `sb_secret_`). Never put the anon key in `SUPABASE_SERVICE_ROLE_KEY`: cron claims then fail with 42501.

## Testing

- Tests never hit live Supabase or the real JWKS (`npm run smoke` is the separate live check). Route tests use `setupHarness()` (`test/helpers/api.ts`): local signed tokens, fake rate limiters and a Supabase fetch stub.
- Cron tests use `setupCronFakes()` (`test/helpers/cron.ts`): in-memory claim/finish RPCs and devices, plus recording Expo/Resend fakes.
- Spy on `rebuildReminders` with `vi.mock('../src/lib/reminders', ...)`, keeping the real exports via `importOriginal`.
- Must cover: Colombo vs UTC dates, status boundaries, rebuildReminders, bad tokens → 401, user B → 404 on user A's rows, unknown fields/oversized/bad UUID → 400/413, sync conflict rules, and cron re-runs not resending.

## Production deploy (first time; do each step with the user)

1. Create the prod Supabase project: Google auth provider, the app's redirect URLs. **Disable email signups** (Google only), so accounts can't be farmed to dodge per-user limits; create the smoke test user from the dashboard.
2. `npx supabase link --project-ref <prod>` → `npx supabase db push` → Security Advisor (only WARN 0029 on the 3 user RPCs is expected). Then set the gateway hash (see Database). Re-link dev afterwards.
3. Fill in `env.production` in `wrangler.jsonc`: `vars` (`SUPABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `EMAIL_FROM` on a verified Resend domain) and the `routes` custom-domain placeholder (`api.example.com`). `workers_dev` and `preview_urls` are already off, because WAF rules don't apply to `*.workers.dev`.
4. `npx wrangler secret put <NAME> --env production` for the 5 secrets (the user types the values).
5. `npm run deploy:prod`, then check `/v1/health` = 200, `BASE_URL=<prod url> npm run smoke` with a prod test user, and the cron trigger in the Cloudflare dashboard.
6. Supabase Auth: JWT expiry ≤ 1 h (tokens aren't revocable), leaked password protection on. Anonymous sign-ins off, email confirmation on. Cloudflare: add a WAF rate-limit rule by IP for `/v1/*` on the custom domain (the binding limits are per user, after auth).
7. On the Workers Paid plan, raise `SUBREQUEST_BUDGET` (`cron/send-reminders.ts`) to ~900.

## Out of scope (v1)

Per-device session revocation, document photos/files, sharing vehicles, SMS, web client.
