-- Reminder engine (P6).
--
-- 1. The unique key gains send_on. With (document_id, days_before, channel) alone, an already
--    sent 7-day reminder would block the 7-day reminder for a renewed expiry date. Keeping
--    send_on in the key keeps history and still dedupes re-runs for the same date.
-- 2. rebuild_reminders(): users may only select reminders, so routes rebuild them through this
--    security definer function. It is the source of truth for reminder rows;
--    buildReminderRows() in src/lib/reminders.ts mirrors it and must stay in sync.

alter table public.reminders drop constraint reminders_document_days_channel_key;
alter table public.reminders add constraint reminders_document_days_channel_send_on_key
  unique (document_id, days_before, channel, send_on);

-- Rebuilds the caller's reminders for p_document_ids (null = all the caller's live documents).
-- Ids that are missing or belong to another user are skipped silently. Deletes the documents'
-- `scheduled` rows, then, for live documents, inserts one row per (reminder day, channel enabled
-- on both profile and document) with send_on = expiry_date - days, skipping send_on before
-- today (Asia/Colombo). Sent/failed/skipped rows are kept.
create function public.rebuild_reminders(p_document_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Asia/Colombo')::date;
  doc_ids uuid[];
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Lock the documents so concurrent rebuilds of the same document serialize.
  select coalesce(array_agg(locked.id), '{}') into doc_ids
  from (
    select d.id
    from public.documents d
    where d.user_id = uid
      and (
        (p_document_ids is null and d.deleted_at is null)
        or d.id = any (p_document_ids)
      )
    order by d.id
    for update
  ) locked;

  delete from public.reminders r
  where r.document_id = any (doc_ids)
    and r.status = 'scheduled';

  insert into public.reminders (user_id, document_id, days_before, send_on, channel)
  select d.user_id, d.id, rd.days, d.expiry_date - rd.days, ch.channel
  from public.documents d
  join public.profiles p on p.id = d.user_id
  cross join lateral unnest(d.reminder_days) as rd(days)
  cross join lateral (
    values ('push', d.push_enabled and p.push_enabled),
           ('email', d.email_enabled and p.email_enabled)
  ) as ch(channel, enabled)
  where d.id = any (doc_ids)
    and d.deleted_at is null
    and ch.enabled
    and d.expiry_date - rd.days >= today
  on conflict (document_id, days_before, channel, send_on) do nothing;
end;
$$;

revoke execute on function public.rebuild_reminders(uuid[]) from public, anon;
grant execute on function public.rebuild_reminders(uuid[]) to authenticated;
