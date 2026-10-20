-- Smoke test for the data_api_gateway migration against a real database. Rolled back.
-- Run: npx supabase db query --linked --yes -f supabase/tests/gateway_smoke.sql
begin;

insert into private.gateway_key (key_sha256)
values (encode(sha256(convert_to('smoke-gateway-key', 'UTF8')), 'hex'))
on conflict (singleton) do update set key_sha256 = excluded.key_sha256;

do $$
begin
  if current_setting('pgrst.db_pre_request', true) is distinct from 'private.check_gateway'
     and not exists (
       select 1 from pg_db_role_setting s
       join pg_roles r on r.oid = s.setrole
       where r.rolname = 'authenticator'
         and 'pgrst.db_pre_request=private.check_gateway' = any (s.setconfig)
     ) then
    raise exception 'pre-request not configured on authenticator';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-4000-8000-00000000000e","role":"authenticated"}', true);
do $$
begin
  -- No header → rejected.
  perform set_config('request.headers', '{}', true);
  begin
    perform private.check_gateway();
    raise exception 'missing header accepted';
  exception when insufficient_privilege then null;
  end;

  -- Wrong key → rejected.
  perform set_config('request.headers', '{"x-vdl-gateway":"wrong"}', true);
  begin
    perform private.check_gateway();
    raise exception 'wrong key accepted';
  exception when insufficient_privilege then null;
  end;

  -- Right key → allowed.
  perform set_config('request.headers', '{"x-vdl-gateway":"smoke-gateway-key"}', true);
  perform private.check_gateway();

  -- The hash table stays unreadable.
  begin
    perform 1 from private.gateway_key;
    raise exception 'gateway_key readable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- The service role (cron) needs no header.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.headers', '{}', true);
select private.check_gateway();
reset role;

select 'gateway_smoke ok' as result;
rollback;
