-- Reminder delivery cron (P9).
--
-- Delivery is at-most-once: the cron claims due rows (scheduled → sending) before it calls Expo or
-- Resend, then records the outcome with finish_reminders(). A re-run only sees `scheduled` rows,
-- so it never resends. Rows left in `sending` by a crashed run are failed ('interrupted') after an
-- hour, never resent, because the provider may already have delivered them.
-- Both functions are for the service role (cron) only.

alter table public.reminders drop constraint reminders_status_check;
alter table public.reminders add constraint reminders_status_check check (
  status in ('scheduled', 'sending', 'sent', 'failed', 'skipped')
);
alter table public.reminders add column claimed_at timestamptz;

-- Fails stale claims, then claims every due `scheduled` row (send_on <= p_today) of the users who
-- own the first p_limit due rows, so a user's rows are never split across batches (one email per
-- user). Returns the rows with the document, vehicle and profile fields needed to deliver them.
create function public.claim_due_reminders(p_today date, p_limit integer default 100)
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

  with due_users as (
    select distinct u.user_id
    from (
      select r.user_id
      from public.reminders r
      where r.status = 'scheduled' and r.send_on <= p_today
      order by r.user_id, r.id
      limit greatest(1, least(p_limit, 500))
    ) u
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

-- Records outcomes for claimed rows: p_results = [{ id, status, error? }], status sent | failed |
-- skipped, or `scheduled` to release a row that was never attempted (budget ran out).
-- Only `sending` rows change, so a late or repeated call can't overwrite a final status.
create or replace function public.finish_reminders(p_results jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.reminders r
  set status = x.status,
      error = left(x.error, 500),
      sent_at = case when x.status = 'sent' then now() end,
      claimed_at = case when x.status = 'scheduled' then null else r.claimed_at end
  from jsonb_to_recordset(p_results) as x(id uuid, status text, error text)
  where r.id = x.id
    and r.status = 'sending'
    and x.status in ('sent', 'failed', 'skipped', 'scheduled');
$$;

revoke execute on function public.claim_due_reminders(date, integer) from public, anon, authenticated;
revoke execute on function public.finish_reminders(jsonb) from public, anon, authenticated;
grant execute on function public.claim_due_reminders(date, integer) to service_role;
grant execute on function public.finish_reminders(jsonb) to service_role;
