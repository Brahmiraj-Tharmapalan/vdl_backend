-- Smoke test for the harden_limits migration against a real database. Rolled back.
-- Run: npx supabase db query --linked --yes -f supabase/tests/harden_smoke.sql
begin;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('e0000000-0000-4000-8000-00000000000e', 'authenticated', 'authenticated', 'e@smoke.test', now()),
  -- Unconfirmed: must not get a reminder_email until the email is confirmed.
  ('a0000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'a@smoke.test', null),
  -- Claim order: Q has the lower id, P has waited longer.
  ('f1000000-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', 'p@smoke.test', now()),
  ('f0000000-0000-4000-8000-0000000000f0', 'authenticated', 'authenticated', 'q@smoke.test', now());

-- reminder_email only for a confirmed email (as the owner; the triggers still run).
do $$
begin
  assert (select reminder_email = 'e@smoke.test' from public.profiles where id = 'e0000000-0000-4000-8000-00000000000e'), 'confirmed user gets reminder_email';
  assert (select reminder_email is null from public.profiles where id = 'a0000000-0000-4000-8000-00000000000a'), 'unconfirmed user gets no reminder_email';
  begin
    update public.profiles set reminder_email = 'a@smoke.test' where id = 'a0000000-0000-4000-8000-00000000000a';
    raise exception 'unconfirmed reminder_email accepted';
  exception when check_violation then null;
  end;
  update auth.users set email_confirmed_at = now() where id = 'a0000000-0000-4000-8000-00000000000a';
  assert (select reminder_email = 'a@smoke.test' from public.profiles where id = 'a0000000-0000-4000-8000-00000000000a'), 'confirming fills reminder_email';
end $$;

select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);

-- As the user (RLS + column grants apply).
set local role authenticated;
do $$
declare
  n integer;
begin
  -- reminder_email: only the account's own email (any case) or null.
  begin
    update public.profiles set reminder_email = 'stranger@smoke.test' where id = 'e0000000-0000-4000-8000-00000000000e';
    raise exception 'foreign reminder_email accepted';
  exception when check_violation then null;
  end;
  update public.profiles set reminder_email = 'E@SMOKE.TEST' where id = 'e0000000-0000-4000-8000-00000000000e';
  update public.profiles set reminder_email = null where id = 'e0000000-0000-4000-8000-00000000000e';

  -- Column grants: server-managed columns and device inserts are not writable.
  begin
    update public.profiles set last_synced_at = now() where id = 'e0000000-0000-4000-8000-00000000000e';
    raise exception 'last_synced_at writable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.devices (user_id, push_token, platform)
    values ('e0000000-0000-4000-8000-00000000000e', 'ExponentPushToken[direct]', 'ios');
    raise exception 'direct device insert allowed';
  exception when insufficient_privilege then null;
  end;

  insert into public.vehicles (id, user_id, plate_number, type)
  values ('eeeeeeee-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 'EEE-1', 'car');
  begin
    update public.vehicles set client_updated_at = '2999-01-01' where id = 'eeeeeeee-0000-4000-8000-000000000001';
    raise exception 'client_updated_at writable';
  exception when insufficient_privilege then null;
  end;

  -- A deleted row is final.
  update public.vehicles set deleted_at = now() where id = 'eeeeeeee-0000-4000-8000-000000000001';
  update public.vehicles set deleted_at = null, plate_number = 'ZZZ-1' where id = 'eeeeeeee-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'deleted vehicle not revived';

  -- sync_changes: > 500 rows rejected; a far-future updated_at is clamped.
  begin
    perform public.sync_changes(null,
      (select jsonb_agg(jsonb_build_object('id', gen_random_uuid())) from generate_series(1, 501)), '[]');
    raise exception '501 rows accepted';
  exception when invalid_parameter_value then null;
  end;
  perform public.sync_changes(null,
    '[{"id":"eeeeeeee-0000-4000-8000-000000000002","nickname":null,"plate_number":"EEE-2","type":"car","updated_at":"2999-01-01T00:00:00Z","deleted_at":null}]',
    '[]');
  assert (select client_updated_at <= now() + interval '5 minutes' from public.vehicles where id = 'eeeeeeee-0000-4000-8000-000000000002'),
    'future client_updated_at clamped';

  -- Devices: Expo tokens only; at most 10 per user (least recently seen evicted).
  begin
    perform public.register_device('not-a-token', 'ios');
    raise exception 'bad token accepted';
  exception when check_violation then null;
  end;
  for i in 1..12 loop
    perform public.register_device('ExponentPushToken[smoke-' || i || ']', 'android');
  end loop;
  -- Re-registering an existing token at the cap keeps it and evicts nothing.
  perform public.register_device('ExponentPushToken[smoke-12]', 'android');
  assert (select count(*) from public.devices where user_id = 'e0000000-0000-4000-8000-00000000000e') = 10, 'device cap is 10';
  assert exists (select 1 from public.devices where push_token = 'ExponentPushToken[smoke-12]'), 'newest device kept';
end $$;
reset role;

-- Quotas (as the owner, so the inserts skip column grants but not triggers).
do $$
begin
  -- EEE-1 is deleted, EEE-2 live: 49 more fill the 50 live slots.
  insert into public.vehicles (id, user_id, plate_number, type)
  select gen_random_uuid(), 'e0000000-0000-4000-8000-00000000000e', 'Q-' || i, 'car' from generate_series(1, 49) i;
  begin
    insert into public.vehicles (id, user_id, plate_number, type)
    values (gen_random_uuid(), 'e0000000-0000-4000-8000-00000000000e', 'Q-OVER', 'car');
    raise exception 'vehicle quota not enforced';
  exception when sqlstate 'VDL01' then null;
  end;
  -- At the cap, an upsert of an existing id still works.
  insert into public.vehicles (id, user_id, plate_number, type)
  values ('eeeeeeee-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-00000000000e', 'EEE-2', 'van')
  on conflict (id) do update set type = excluded.type;
  assert (select type = 'van' from public.vehicles where id = 'eeeeeeee-0000-4000-8000-000000000002'), 'upsert at cap allowed';
end $$;

-- Claim order: the longest-waiting user first, not the lowest id.
insert into public.vehicles (id, user_id, plate_number, type) values
  ('ffffffff-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000f1', 'PPP-1', 'car'),
  ('ffffffff-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-0000000000f0', 'QQQ-1', 'car');
insert into public.documents (id, user_id, vehicle_id, type, expiry_date, reminder_days) values
  ('ffffffff-0000-4000-8000-000000000011', 'f1000000-0000-4000-8000-0000000000f1', 'ffffffff-0000-4000-8000-000000000001', 'insurance', '2000-01-10', '{7}'),
  ('ffffffff-0000-4000-8000-000000000012', 'f0000000-0000-4000-8000-0000000000f0', 'ffffffff-0000-4000-8000-000000000002', 'insurance', '2000-01-10', '{7}');
insert into public.reminders (user_id, document_id, days_before, send_on, channel) values
  ('f1000000-0000-4000-8000-0000000000f1', 'ffffffff-0000-4000-8000-000000000011', 7, '1999-12-01', 'push'),
  ('f0000000-0000-4000-8000-0000000000f0', 'ffffffff-0000-4000-8000-000000000012', 7, '1999-12-02', 'push');
do $$
begin
  assert (select array_agg(distinct c.user_id) from public.claim_due_reminders('2000-01-03', 1) c)
    = array['f1000000-0000-4000-8000-0000000000f1'::uuid], 'oldest due user claimed first';
end $$;

select 'harden smoke: all asserts passed' as result;
rollback;
