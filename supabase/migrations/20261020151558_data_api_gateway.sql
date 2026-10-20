-- Data API gateway (security audit).
--
-- The app ships the anon key, so a signed-in user could call PostgREST and the RPCs directly with
-- their own JWT and skip the Worker's rate limits (e.g. loop rebuild_reminders or sync_changes and
-- load the shared database). A PostgREST pre-request check now rejects every Data API request
-- (REST, RPC, GraphQL) that lacks the Worker's `x-vdl-gateway` header. Supabase Auth is not
-- PostgREST, so sign-in keeps working. The service role (cron) is exempt.
--
-- Only a sha256 hash of the key is stored, in a schema PostgREST doesn't expose. Set it per project
-- (the Worker secret GATEWAY_KEY holds the plain key):
--   insert into private.gateway_key (key_sha256) values (encode(sha256(convert_to('<key>', 'UTF8')), 'hex'))
--   on conflict (singleton) do update set key_sha256 = excluded.key_sha256;
-- Until a hash is set, every non-service request fails closed.

create schema if not exists private;
revoke all on schema private from public;

create table private.gateway_key (
  singleton boolean primary key default true check (singleton),
  key_sha256 text not null check (key_sha256 ~ '^[0-9a-f]{64}$')
);
revoke all on table private.gateway_key from public, anon, authenticated;

-- PostgREST runs the pre-request function as the request's role, so anon/authenticated need
-- execute; security definer lets it read the hash they can't select.
create function private.check_gateway()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(nullif(pg_catalog.current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  headers jsonb := coalesce(nullif(pg_catalog.current_setting('request.headers', true), ''), '{}')::jsonb;
  presented text := headers ->> 'x-vdl-gateway';
begin
  if claims ->> 'role' = 'service_role' then
    return;
  end if;
  if presented is null or not exists (
    select 1 from private.gateway_key g
    where g.key_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(presented, 'UTF8')), 'hex')
  ) then
    raise exception 'Data API access is only allowed through the API'
      using errcode = '42501', hint = 'gateway';
  end if;
end;
$$;

revoke execute on function private.check_gateway() from public;
grant usage on schema private to anon, authenticated, service_role;
grant execute on function private.check_gateway() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'private.check_gateway';
notify pgrst, 'reload config';
