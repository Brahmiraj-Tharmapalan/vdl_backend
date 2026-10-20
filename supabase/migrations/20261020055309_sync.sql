-- Sync (P8).
--
-- 1. client_updated_at holds the client's updatedAt for last-write-wins. updated_at stays the
--    server sync cursor (always now()). A REST update that leaves client_updated_at unchanged
--    gets now(), so every REST write counts as "edited now".
-- 2. sync_changes(): push + pull in one transaction. It is security definer (RLS doesn't
--    apply inside), so every statement filters by auth.uid() itself.
--    shouldApply() in src/lib/sync.ts mirrors its merge rule and must stay in sync.

alter table public.vehicles add column client_updated_at timestamptz not null default now();
alter table public.documents add column client_updated_at timestamptz not null default now();

create function public.set_client_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_updated_at is not distinct from old.client_updated_at then
    new.client_updated_at = now();
  end if;
  return new;
end;
$$;

create trigger vehicles_set_client_updated_at before update on public.vehicles
  for each row execute function public.set_client_updated_at();
create trigger documents_set_client_updated_at before update on public.documents
  for each row execute function public.set_client_updated_at();

-- Applies the caller's changes and returns everything they need to pull.
--
-- Merge rule (per row): last write wins on client_updated_at, and a delete always wins. An
-- incoming delete always applies; an incoming edit applies only if it is newer; a row already
-- deleted on the server is never changed again.
-- Rejected rows (reported, not applied): ids owned by another account ('id_in_use'), and
-- documents whose vehicle isn't the caller's, or is deleted while the document is live
-- ('vehicle_not_found').
-- A vehicle deleted here soft-deletes its live documents with the same deleted_at. Reminders
-- are rebuilt for every changed document. profiles.last_synced_at = now().
-- Pull: rows (soft-deleted included) with updated_at > p_last_synced_at (null = all), plus every
-- pushed, non-rejected id, so a losing client always gets the winning version back.
-- server_time is now() - 60 s: now() is the transaction start, and a concurrent transaction
-- that stamped an earlier updated_at commits well within 60 s. Re-delivery is idempotent.
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
declare
  uid uuid := auth.uid();
  rejected jsonb;
  pushed_vehicle_ids uuid[];
  pushed_document_ids uuid[];
  deleted_vehicle_ids uuid[];
  changed_document_ids uuid[];
  cascaded_document_ids uuid[];
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Vehicles: reject ids owned by another account.
  select
    coalesce(
      jsonb_agg(jsonb_build_object('entity', 'vehicle', 'id', x.id, 'reason', 'id_in_use'))
        filter (where v.id is not null),
      '[]'
    ),
    coalesce(array_agg(x.id) filter (where v.id is null), '{}')
  into rejected, pushed_vehicle_ids
  from jsonb_to_recordset(p_vehicles) as x(id uuid)
  left join public.vehicles v on v.id = x.id and v.user_id <> uid;

  with applied as (
    insert into public.vehicles as v
      (id, user_id, nickname, plate_number, type, deleted_at, client_updated_at)
    select x.id, uid, x.nickname, x.plate_number, x.type, x.deleted_at, x.updated_at
    from jsonb_to_recordset(p_vehicles) as x(
      id uuid, nickname text, plate_number text, type text,
      updated_at timestamptz, deleted_at timestamptz
    )
    where x.id = any (pushed_vehicle_ids)
    on conflict (id) do update set
      nickname = excluded.nickname,
      plate_number = excluded.plate_number,
      type = excluded.type,
      deleted_at = excluded.deleted_at,
      client_updated_at = greatest(v.client_updated_at, excluded.client_updated_at)
    where v.user_id = uid
      and v.deleted_at is null
      and (excluded.deleted_at is not null or v.client_updated_at < excluded.client_updated_at)
    returning v.id, v.deleted_at
  )
  select coalesce(array_agg(a.id) filter (where a.deleted_at is not null), '{}')
  into deleted_vehicle_ids
  from applied a;

  -- Same rule as DELETE /v1/vehicles/:id: the vehicle's live documents go with it.
  with cascaded as (
    update public.documents d
    set deleted_at = v.deleted_at,
        client_updated_at = greatest(d.client_updated_at, v.client_updated_at)
    from public.vehicles v
    where v.id = any (deleted_vehicle_ids)
      and d.vehicle_id = v.id
      and d.user_id = uid
      and d.deleted_at is null
    returning d.id
  )
  select coalesce(array_agg(c.id), '{}') into cascaded_document_ids from cascaded c;

  -- Documents: reject foreign ids and vehicles that aren't the caller's (or are deleted while
  -- the document is live).
  with checked as (
    select
      x.id,
      case
        when exists (
          select 1 from public.documents d where d.id = x.id and d.user_id <> uid
        ) then 'id_in_use'
        when not exists (
          select 1 from public.vehicles v
          where v.id = x.vehicle_id
            and v.user_id = uid
            and (x.deleted_at is not null or v.deleted_at is null)
        ) then 'vehicle_not_found'
      end as reason
    from jsonb_to_recordset(p_documents) as x(id uuid, vehicle_id uuid, deleted_at timestamptz)
  )
  select
    rejected || coalesce(
      jsonb_agg(jsonb_build_object('entity', 'document', 'id', c.id, 'reason', c.reason))
        filter (where c.reason is not null),
      '[]'
    ),
    coalesce(array_agg(c.id) filter (where c.reason is null), '{}')
  into rejected, pushed_document_ids
  from checked c;

  with applied as (
    insert into public.documents as d (
      id, user_id, vehicle_id, type, custom_name, expiry_date, reminder_days,
      push_enabled, email_enabled, deleted_at, client_updated_at
    )
    select
      x.id, uid, x.vehicle_id, x.type, x.custom_name, x.expiry_date, x.reminder_days,
      x.push_enabled, x.email_enabled, x.deleted_at, x.updated_at
    from jsonb_to_recordset(p_documents) as x(
      id uuid, vehicle_id uuid, type text, custom_name text, expiry_date date,
      reminder_days integer[], push_enabled boolean, email_enabled boolean,
      updated_at timestamptz, deleted_at timestamptz
    )
    where x.id = any (pushed_document_ids)
    on conflict (id) do update set
      vehicle_id = excluded.vehicle_id,
      type = excluded.type,
      custom_name = excluded.custom_name,
      expiry_date = excluded.expiry_date,
      reminder_days = excluded.reminder_days,
      push_enabled = excluded.push_enabled,
      email_enabled = excluded.email_enabled,
      deleted_at = excluded.deleted_at,
      client_updated_at = greatest(d.client_updated_at, excluded.client_updated_at)
    where d.user_id = uid
      and d.deleted_at is null
      and (excluded.deleted_at is not null or d.client_updated_at < excluded.client_updated_at)
    returning d.id
  )
  select coalesce(array_agg(a.id), '{}') into changed_document_ids from applied a;

  changed_document_ids := changed_document_ids || cascaded_document_ids;
  if cardinality(changed_document_ids) > 0 then
    perform public.rebuild_reminders(changed_document_ids);
  end if;

  update public.profiles set last_synced_at = now() where id = uid;

  return jsonb_build_object(
    'server_time', now() - interval '60 seconds',
    'rejected', rejected,
    'vehicles', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.updated_at, v.id)
      from public.vehicles v
      where v.user_id = uid
        and (
          p_last_synced_at is null
          or v.updated_at > p_last_synced_at
          or v.id = any (pushed_vehicle_ids)
        )
    ), '[]'),
    'documents', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.updated_at, d.id)
      from public.documents d
      where d.user_id = uid
        and (
          p_last_synced_at is null
          or d.updated_at > p_last_synced_at
          or d.id = any (pushed_document_ids)
        )
    ), '[]')
  );
end;
$$;

revoke execute on function public.sync_changes(timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.sync_changes(timestamptz, jsonb, jsonb) to authenticated;
