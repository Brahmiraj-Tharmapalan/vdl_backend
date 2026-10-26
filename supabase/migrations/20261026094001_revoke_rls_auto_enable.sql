-- Projects created with the dashboard's "Enable automatic RLS" option get public.rls_auto_enable(),
-- a security definer event-trigger function that anyone may execute by default (Security Advisor
-- WARN 0028/0029). It only works as an event trigger, so nobody needs to call it. Revoking EXECUTE
-- doesn't stop the trigger: Postgres doesn't check EXECUTE when it fires one.
-- A no-op on projects without the function (e.g. dev).
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
