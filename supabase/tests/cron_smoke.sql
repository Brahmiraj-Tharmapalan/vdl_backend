-- Smoke test for claim_due_reminders() / finish_reminders() against a real database. Rolled back.
-- Run: npx supabase db query --linked --yes -f supabase/tests/cron_smoke.sql
begin;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('c0000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'c@smoke.test', now()),
  ('d0000000-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', 'd@smoke.test', null);
-- A reminder_email left on an unconfirmed account (e.g. set before the confirmed-email rule).
alter table public.profiles disable trigger profiles_check_reminder_email;
update public.profiles set reminder_email = 'd@smoke.test' where id = 'd0000000-0000-4000-8000-00000000000d';
alter table public.profiles enable trigger profiles_check_reminder_email;
insert into public.vehicles (id, user_id, plate_number, type) values
  ('dddddddd-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000000d', 'DDD-1', 'car');
insert into public.documents (id, user_id, vehicle_id, type, expiry_date, reminder_days) values
  ('dddddddd-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-00000000000d',
   'dddddddd-0000-4000-8000-000000000001', 'insurance', '2099-01-10', '{7}');
insert into public.reminders (user_id, document_id, days_before, send_on, channel) values
  ('d0000000-0000-4000-8000-00000000000d', 'dddddddd-0000-4000-8000-000000000002', 7, '2099-01-03', 'email');
insert into public.vehicles (id, user_id, plate_number, type) values
  ('cccccccc-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', 'CCC-1', 'car');
insert into public.documents (id, user_id, vehicle_id, type, expiry_date, reminder_days) values
  ('cccccccc-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000c',
   'cccccccc-0000-4000-8000-000000000001', 'insurance', '2099-01-10', '{7}');
insert into public.reminders (id, user_id, document_id, days_before, send_on, channel, status, claimed_at) values
  ('cccccccc-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000002', 7, '2099-01-03', 'push', 'scheduled', null),
  ('cccccccc-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000002', 7, '2099-01-03', 'email', 'scheduled', null),
  ('cccccccc-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000002', 8, '2099-01-02', 'push', 'sending', now() - interval '2 hours'),
  ('cccccccc-0000-4000-8000-0000000000a4', 'c0000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000002', 9, '2099-01-01', 'email', 'scheduled', null);

do $$
declare
  n integer;
begin
  -- Not due yet: nothing claimed, but the stale claim is failed.
  select count(*) into n from public.claim_due_reminders('2098-12-31', 100) c where c.user_id = 'c0000000-0000-4000-8000-00000000000c';
  assert n = 0, 'rows not due are not claimed';
  assert (select status = 'failed' and error = 'interrupted' from public.reminders where id = 'cccccccc-0000-4000-8000-0000000000a3'), 'stale claim failed';

  -- Due: every due row (send_on <= today) claimed with its joined fields.
  create temp table claimed as select * from public.claim_due_reminders('2099-01-03', 100);
  select count(*) into n from claimed c
  where c.user_id = 'c0000000-0000-4000-8000-00000000000c' and c.plate_number = 'CCC-1' and c.doc_type = 'insurance';
  assert n = 3, 'due rows claimed (send_on <= today)';
  -- reminder_email is handed out only for a confirmed account.
  assert (select bool_and(c.reminder_email = 'c@smoke.test') from claimed c
          where c.user_id = 'c0000000-0000-4000-8000-00000000000c'), 'confirmed user gets reminder_email';
  assert (select count(*) = 1 and bool_and(c.reminder_email is null) from claimed c
          where c.user_id = 'd0000000-0000-4000-8000-00000000000d'), 'unconfirmed user gets no reminder_email';
  assert (select count(*) from public.reminders where document_id = 'cccccccc-0000-4000-8000-000000000002' and status = 'sending') = 3, 'claimed rows are sending';

  -- A re-run claims nothing.
  select count(*) into n from public.claim_due_reminders('2099-01-03', 100) c where c.user_id = 'c0000000-0000-4000-8000-00000000000c';
  assert n = 0, 're-run claims nothing';

  perform public.finish_reminders('[{"id":"cccccccc-0000-4000-8000-0000000000a1","status":"sent"},
    {"id":"cccccccc-0000-4000-8000-0000000000a2","status":"failed","error":"resend_500"},
    {"id":"cccccccc-0000-4000-8000-0000000000a3","status":"sent"},
    {"id":"cccccccc-0000-4000-8000-0000000000a4","status":"scheduled"}]');
  assert (select status = 'sent' and sent_at is not null from public.reminders where id = 'cccccccc-0000-4000-8000-0000000000a1'), 'sent recorded';
  assert (select status = 'failed' and error = 'resend_500' and sent_at is null from public.reminders where id = 'cccccccc-0000-4000-8000-0000000000a2'), 'failure recorded';
  assert (select status = 'failed' from public.reminders where id = 'cccccccc-0000-4000-8000-0000000000a3'), 'final status not overwritten';
  assert (select status = 'scheduled' and claimed_at is null from public.reminders where id = 'cccccccc-0000-4000-8000-0000000000a4'), 'unattempted row released';
end $$;

-- Only the service role may call them.
set local role authenticated;
do $$
begin
  begin
    perform public.claim_due_reminders('2099-01-03', 1);
    raise exception 'authenticated could call claim_due_reminders';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'cron smoke: all asserts passed' as result;
rollback;
