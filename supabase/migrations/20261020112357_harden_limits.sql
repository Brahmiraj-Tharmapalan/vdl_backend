-- Hardening (security audit).
--
-- The app ships the Supabase URL and anon key, so a signed-in user can call PostgREST and the
-- RPCs directly with their own JWT, skipping the Worker's zod limits, rate limits and body limits.
-- RLS already keeps users to their own rows; this migration moves the remaining rules into the DB:
-- 1. Per-user quotas (vehicles, documents, devices), so one user can't grow the DB or the cron
--    workload without bound. Violations raise SQLSTATE VDL01 (→ 409 limit_reached in the Worker).
-- 2. client_updated_at is clamped to at most now() + 5 min (same as the zod sync rule), so a row
--    can't be made to win every future last-write-wins merge.
-- 3. A soft-deleted vehicle or document never changes again (updates to it are skipped).
-- 4. Column-level grants: users can only write the columns the routes write.
-- 5. reminder_email may only be the account's own email (same as PATCH /v1/me).
-- 6. Push tokens must be Expo tokens; register_device keeps at most 10 devices per user.
-- 7. sync_changes rejects more than 500 rows per array.
-- 8. claim_due_reminders serves users with the oldest due reminders first (ties by a daily hash),
--    not by user_id, and p_limit now counts users.

-- ---------------------------------------------------------------------------
-- 2. client_updated_at clamp (existing rows first)
-- ---------------------------------------------------------------------------

update public.vehicles set client_updated_at = now()
where client_updated_at > now() + interval '5 minutes';
update public.documents set client_updated_at = now()
where client_updated_at > now() + interval '5 minutes';

create function public.clamp_client_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_updated_at > now() + interval '5 minutes' then
    new.client_updated_at = now();
  end if;
  return new;
end;
$$;

-- Runs before *_set_client_updated_at (triggers fire in name order). EXCLUDED in sync_changes'
-- upserts already holds the clamped value.
create trigger vehicles_clamp_client_updated_at before insert or update on public.vehicles
  for each row execute function public.clamp_client_updated_at();
create trigger documents_clamp_client_updated_at before insert or update on public.documents
  for each row execute function public.clamp_client_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Deleted rows are final
-- ---------------------------------------------------------------------------

-- Returning null skips the update, so a REST PATCH on a deleted row matches nothing (→ 404).
create function public.keep_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    return null;
  end if;
  return new;
end;
$$;

create trigger vehicles_keep_deleted before update on public.vehicles
  for each row execute function public.keep_deleted();
create trigger documents_keep_deleted before update on public.documents
  for each row execute function public.keep_deleted();

-- ---------------------------------------------------------------------------
-- 1. Quotas: TG_ARGV = (max live rows, max rows including soft-deleted)
-- ---------------------------------------------------------------------------

create function public.enforce_user_quota()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  live_max integer := tg_argv[0]::integer;
  total_max integer := tg_argv[1]::integer;
  live integer;
  total integer;
  existing boolean;
begin
  -- An upsert of an existing id fires BEFORE INSERT too; only new rows count.
  execute format('select exists (select 1 from public.%I where id = $1)', tg_table_name)
    into existing using new.id;
  if existing then
    return new;
  end if;

  -- Serialize a user's inserts so concurrent requests can't both pass the count.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('quota:' || tg_table_name || ':' || new.user_id::text)
  );
  execute format(
    'select count(*), count(*) filter (where deleted_at is null) from public.%I where user_id = $1',
    tg_table_name
  ) into total, live using new.user_id;

  if total >= total_max or (new.deleted_at is null and live >= live_max) then
    raise exception 'quota exceeded for %', tg_table_name using errcode = 'VDL01';
  end if;
  return new;
end;
$$;

create trigger vehicles_enforce_quota before insert on public.vehicles
  for each row execute function public.enforce_user_quota('50', '500');
create trigger documents_enforce_quota before insert on public.documents
  for each row execute function public.enforce_user_quota('300', '3000');

-- ---------------------------------------------------------------------------
-- 5. reminder_email = the account's own email
-- ---------------------------------------------------------------------------

-- security definer: it reads auth.users. Compared case-insensitively.
create function public.check_reminder_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reminder_email is not null
     and new.reminder_email is distinct from old.reminder_email
     and not exists (
       select 1 from auth.users u
       where u.id = new.id and lower(u.email) = lower(new.reminder_email)
     ) then
    raise exception 'reminder_email must be the account email' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.check_reminder_email() from public, anon, authenticated;

create trigger profiles_check_reminder_email before update on public.profiles
  for each row execute function public.check_reminder_email();

-- ---------------------------------------------------------------------------
-- 4. Column-level grants (select and delete stay as they were)
-- ---------------------------------------------------------------------------

revoke insert, update on table public.profiles, public.vehicles, public.documents, public.devices
  from authenticated;

grant update (display_name, reminder_email, push_enabled, email_enabled, default_reminder_days, theme)
  on table public.profiles to authenticated;
grant insert (id, user_id, nickname, plate_number, type)
  on table public.vehicles to authenticated;
grant update (nickname, plate_number, type, deleted_at)
  on table public.vehicles to authenticated;
grant insert (id, user_id, vehicle_id, type, custom_name, expiry_date, reminder_days, push_enabled, email_enabled)
  on table public.documents to authenticated;
grant update (type, custom_name, expiry_date, reminder_days, push_enabled, email_enabled, deleted_at)
  on table public.documents to authenticated;
-- Devices are created only through register_device.
grant update (last_seen_at) on table public.devices to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Devices: Expo tokens only, at most 10 per user
-- ---------------------------------------------------------------------------

delete from public.devices where push_token !~ '^Expo(nent)?PushToken\[[^]]+\]$';
alter table public.devices add constraint devices_push_token_format
  check (push_token ~ '^Expo(nent)?PushToken\[[^]]+\]$');

create or replace function public.register_device(
  p_push_token text,
  p_platform text,
  p_device_name text default null
)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  result public.devices;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Already this user's token: refresh it (never counts against the cap).
  update public.devices
  set platform = p_platform, device_name = p_device_name, last_seen_at = now()
  where push_token = p_push_token and user_id = uid
  returning * into result;
  if found then
    return result;
  end if;

  -- Make room: keep the 9 most recently seen devices, then add (or take over) this one.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('quota:devices:' || uid::text));
  delete from public.devices
  where id in (
    select d.id from public.devices d
    where d.user_id = uid
    order by d.last_seen_at desc, d.id
    offset 9
  );

  insert into public.devices (user_id, push_token, platform, device_name, last_seen_at)
  values (uid, p_push_token, p_platform, p_device_name, now())
  on conflict (push_token) do update
    set user_id = uid,
        platform = excluded.platform,
        device_name = excluded.device_name,
        last_seen_at = now()
  returning * into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. sync_changes size limit
-- ---------------------------------------------------------------------------

-- The original becomes an internal function; the public one checks sizes first, then calls it.
alter function public.sync_changes(timestamptz, jsonb, jsonb) rename to sync_changes_unchecked;
revoke execute on function public.sync_changes_unchecked(timestamptz, jsonb, jsonb)
  from public, anon, authenticated;

create function public.sync_changes(
  p_last_synced_at timestamptz default null,
  p_vehicles jsonb default '[]',
  p_documents jsonb default '[]'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(coalesce(p_vehicles, '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_documents, '[]')) <> 'array'
     or jsonb_array_length(coalesce(p_vehicles, '[]')) > 500
     or jsonb_array_length(coalesce(p_documents, '[]')) > 500 then
    raise exception 'at most 500 vehicles and 500 documents per sync' using errcode = '22023';
  end if;
  return public.sync_changes_unchecked(
    p_last_synced_at, coalesce(p_vehicles, '[]'), coalesce(p_documents, '[]')
  );
end;
$$;

revoke execute on function public.sync_changes(timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.sync_changes(timestamptz, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Fair claim order
-- ---------------------------------------------------------------------------

create or replace function public.claim_due_reminders(p_today date, p_limit integer default 100)
returns table (
  id uuid,
  user_id uuid,
  document_id uuid,
  days_before integer,
  send_on date,
  channel text,
  doc_type text,
  custom_name text,
  expiry_date date,
  doc_push_enabled boolean,
  doc_email_enabled boolean,
  doc_deleted_at timestamptz,
  plate_number text,
  nickname text,
  vehicle_deleted_at timestamptz,
  profile_push_enabled boolean,
  profile_email_enabled boolean,
  reminder_email text
)
language sql
security definer
set search_path = ''
as $$
  update public.reminders r
  set status = 'failed', error = 'interrupted'
  where r.status = 'sending'
    and r.claimed_at < now() - interval '1 hour';

  -- p_limit users: the longest-waiting first, ties in a daily-rotating order, so no user id
  -- is always first or always last.
  with due_users as (
    select r.user_id
    from public.reminders r
    where r.status = 'scheduled' and r.send_on <= p_today
    group by r.user_id
    order by min(r.send_on), md5(r.user_id::text || p_today::text)
    limit greatest(1, least(p_limit, 500))
  ),
  picked as (
    select r.id
    from public.reminders r
    where r.user_id in (select du.user_id from due_users du)
      and r.status = 'scheduled'
      and r.send_on <= p_today
    for update of r skip locked
  ),
  claimed as (
    update public.reminders r
    set status = 'sending', claimed_at = now()
    from picked
    where r.id = picked.id
    returning r.id, r.user_id, r.document_id, r.days_before, r.send_on, r.channel
  )
  select
    c.id, c.user_id, c.document_id, c.days_before, c.send_on, c.channel,
    d.type, d.custom_name, d.expiry_date, d.push_enabled, d.email_enabled, d.deleted_at,
    v.plate_number, v.nickname, v.deleted_at,
    p.push_enabled, p.email_enabled, p.reminder_email
  from claimed c
  join public.documents d on d.id = c.document_id
  join public.vehicles v on v.id = d.vehicle_id
  join public.profiles p on p.id = c.user_id
  order by c.user_id, c.send_on, c.id;
$$;
