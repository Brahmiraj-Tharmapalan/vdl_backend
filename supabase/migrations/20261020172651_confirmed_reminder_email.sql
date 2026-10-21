-- Reminder emails only go to a confirmed address (security audit M2).
--
-- Before this, reminder_email was set from auth.users.email at sign-up whether or not it was
-- confirmed. With email sign-up on and confirmations off, someone could sign up as a stranger's
-- address and the daily cron would email that stranger. Now:
-- 1. A new user gets reminder_email only if their email is already confirmed (Google: yes).
-- 2. When an email is confirmed later, reminder_email is filled in if it is still null.
-- 3. reminder_email can only be set to the account's own *confirmed* email.
-- 4. Existing unconfirmed users lose their reminder_email.
-- 5. claim_due_reminders returns reminder_email only for confirmed users, so nothing is sent to
--    an unconfirmed address even if a row slipped through (the cron then skips it as `no_email`).

-- ---------------------------------------------------------------------------
-- 1. Profile on sign-up
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, reminder_email)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 100),
    case when new.email_confirmed_at is not null then left(new.email, 254) end
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Email confirmed later
-- ---------------------------------------------------------------------------

create function public.handle_user_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set reminder_email = left(new.email, 254)
  where id = new.id and reminder_email is null;
  return new;
end;
$$;

revoke execute on function public.handle_user_email_confirmed() from public, anon, authenticated;

create trigger on_auth_user_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null and new.email is not null)
  execute function public.handle_user_email_confirmed();

-- ---------------------------------------------------------------------------
-- 3. reminder_email = the account's own confirmed email
-- ---------------------------------------------------------------------------

create or replace function public.check_reminder_email()
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
       where u.id = new.id
         and u.email_confirmed_at is not null
         and lower(u.email) = lower(new.reminder_email)
     ) then
    raise exception 'reminder_email must be the confirmed account email' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------

update public.profiles p
set reminder_email = null
from auth.users u
where u.id = p.id and u.email_confirmed_at is null and p.reminder_email is not null;

-- ---------------------------------------------------------------------------
-- 5. Cron: never hand out an unconfirmed address
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
    p.push_enabled, p.email_enabled,
    case when u.email_confirmed_at is not null then p.reminder_email end
  from claimed c
  join public.documents d on d.id = c.document_id
  join public.vehicles v on v.id = d.vehicle_id
  join public.profiles p on p.id = c.user_id
  left join auth.users u on u.id = c.user_id
  order by c.user_id, c.send_on, c.id;
$$;
