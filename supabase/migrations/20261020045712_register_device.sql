-- Register (or take over) a push token for the calling user.
-- devices.push_token is globally unique and RLS hides other users' rows, so a phone that
-- signs into another account can't claim its token with a plain upsert. This function
-- reassigns it. user_id always comes from auth.uid(), never from a parameter.

create function public.register_device(
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

revoke execute on function public.register_device(text, text, text) from public, anon;
grant execute on function public.register_device(text, text, text) to authenticated;
