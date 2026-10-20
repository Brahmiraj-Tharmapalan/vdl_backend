-- Smoke test for sync_changes() against a real database. Everything is rolled back.
-- Run: npx supabase db query --linked --yes -f supabase/tests/sync_smoke.sql
-- (or paste into the SQL Editor). Any failed assert aborts with an error.
begin;

insert into auth.users (id, aud, role, email) values
  ('a0000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'a@smoke.test'),
  ('b0000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'b@smoke.test');

-- User B owns a vehicle and a document, both with ids user A will try to reuse.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select public.sync_changes(null,
  '[{"id":"bbbbbbbb-0000-4000-8000-000000000001","nickname":null,"plate_number":"BBB-1","type":"car","updated_at":"2026-10-01T00:00:00Z","deleted_at":null}]',
  '[{"id":"bbbbbbbb-0000-4000-8000-000000000002","vehicle_id":"bbbbbbbb-0000-4000-8000-000000000001","type":"insurance","custom_name":null,"expiry_date":"2099-01-01","reminder_days":[7],"push_enabled":true,"email_enabled":true,"updated_at":"2026-10-01T00:00:00Z","deleted_at":null}]');

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

do $$
declare
  r jsonb;
begin
  -- First push: A's vehicle + document, plus B's ids and a doc on B's vehicle.
  r := public.sync_changes(null,
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","nickname":"Car","plate_number":"AAA-1","type":"car","updated_at":"2026-10-10T00:00:00Z","deleted_at":null},
      {"id":"bbbbbbbb-0000-4000-8000-000000000001","nickname":null,"plate_number":"XXX-1","type":"van","updated_at":"2026-10-10T00:00:00Z","deleted_at":null}]',
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000002","vehicle_id":"aaaaaaaa-0000-4000-8000-000000000001","type":"insurance","custom_name":null,"expiry_date":"2099-01-01","reminder_days":[30,7],"push_enabled":true,"email_enabled":true,"updated_at":"2026-10-10T00:00:00Z","deleted_at":null},
      {"id":"bbbbbbbb-0000-4000-8000-000000000002","vehicle_id":"aaaaaaaa-0000-4000-8000-000000000001","type":"insurance","custom_name":null,"expiry_date":"2099-01-01","reminder_days":[7],"push_enabled":true,"email_enabled":true,"updated_at":"2026-10-10T00:00:00Z","deleted_at":null},
      {"id":"aaaaaaaa-0000-4000-8000-000000000003","vehicle_id":"bbbbbbbb-0000-4000-8000-000000000001","type":"insurance","custom_name":null,"expiry_date":"2099-01-01","reminder_days":[7],"push_enabled":true,"email_enabled":true,"updated_at":"2026-10-10T00:00:00Z","deleted_at":null}]');

  assert jsonb_array_length(r -> 'vehicles') = 1, 'A pulls only its own vehicle';
  assert jsonb_array_length(r -> 'documents') = 1, 'A pulls only its own document';
  assert r -> 'rejected' @> '[{"entity":"vehicle","id":"bbbbbbbb-0000-4000-8000-000000000001","reason":"id_in_use"}]', 'foreign vehicle id rejected';
  assert r -> 'rejected' @> '[{"entity":"document","id":"bbbbbbbb-0000-4000-8000-000000000002","reason":"id_in_use"}]', 'foreign document id rejected';
  assert r -> 'rejected' @> '[{"entity":"document","id":"aaaaaaaa-0000-4000-8000-000000000003","reason":"vehicle_not_found"}]', 'foreign vehicleId rejected';
  assert (select plate_number from public.vehicles where id = 'bbbbbbbb-0000-4000-8000-000000000001') = 'BBB-1', 'B''s vehicle untouched';
  assert (select count(*) from public.reminders where document_id = 'aaaaaaaa-0000-4000-8000-000000000002') = 4, 'reminders rebuilt (2 days x 2 channels)';
  assert (select last_synced_at is not null from public.profiles where id = 'a0000000-0000-4000-8000-00000000000a'), 'last_synced_at saved';
  assert (select client_updated_at from public.vehicles where id = 'aaaaaaaa-0000-4000-8000-000000000001') = '2026-10-10T00:00:00Z', 'client_updated_at stored';

  -- Older edit is ignored, but the server row is still returned.
  r := public.sync_changes(now(),
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","nickname":"Old","plate_number":"OLD-1","type":"car","updated_at":"2026-10-05T00:00:00Z","deleted_at":null}]',
    '[]');
  assert (select plate_number from public.vehicles where id = 'aaaaaaaa-0000-4000-8000-000000000001') = 'AAA-1', 'older row ignored';
  assert r -> 'vehicles' -> 0 ->> 'plate_number' = 'AAA-1', 'losing push gets the server version';

  -- Newer edit applies.
  perform public.sync_changes(now(),
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","nickname":"New","plate_number":"NEW-1","type":"car","updated_at":"2026-10-11T00:00:00Z","deleted_at":null}]',
    '[]');
  assert (select plate_number from public.vehicles where id = 'aaaaaaaa-0000-4000-8000-000000000001') = 'NEW-1', 'newer row applied';

  -- Delete wins even with an older timestamp, and cascades to live documents.
  r := public.sync_changes(null,
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","nickname":"New","plate_number":"NEW-1","type":"car","updated_at":"2026-10-01T00:00:00Z","deleted_at":"2026-10-01T00:00:00Z"}]',
    '[]');
  assert (select deleted_at is not null from public.vehicles where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'delete applied';
  assert (select deleted_at is not null from public.documents where id = 'aaaaaaaa-0000-4000-8000-000000000002'), 'delete cascaded to documents';
  assert (select count(*) from public.reminders where document_id = 'aaaaaaaa-0000-4000-8000-000000000002' and status = 'scheduled') = 0, 'cascaded doc reminders removed';
  assert r -> 'documents' -> 0 ->> 'deleted_at' is not null, 'soft-deleted rows are returned';

  -- A deleted row never changes again.
  perform public.sync_changes(null,
    '[{"id":"aaaaaaaa-0000-4000-8000-000000000001","nickname":"Zombie","plate_number":"ZZZ-1","type":"car","updated_at":"2026-10-20T00:00:00Z","deleted_at":null}]',
    '[]');
  assert (select deleted_at is not null and plate_number = 'NEW-1' from public.vehicles where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'deleted row not revived';

  -- REST-style update bumps client_updated_at to now().
  update public.documents set expiry_date = '2099-02-01' where id = 'aaaaaaaa-0000-4000-8000-000000000002';
  assert (select client_updated_at = now() from public.documents where id = 'aaaaaaaa-0000-4000-8000-000000000002'), 'trigger stamps client_updated_at';
end;
$$;

-- Grants: anon can't call it.
do $$
begin
  set local role anon;
  begin
    perform public.sync_changes(null, '[]', '[]');
    raise exception 'anon could call sync_changes';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end;
$$;

select 'sync smoke: all asserts passed' as result;
rollback;
