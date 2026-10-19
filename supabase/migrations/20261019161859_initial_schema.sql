-- Vehicle Doc Lanka: initial schema.
-- Stores only what the app shows (see AGENTS.md "Core rules"). Limits match the zod schemas.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Always stamp updated_at with server time so it is a trusted sync cursor.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 100),
  reminder_email text check (char_length(reminder_email) <= 254),
  push_enabled boolean not null default true,
  email_enabled boolean not null default true,
  default_reminder_days integer[] not null default '{30,7,1}',
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_default_reminder_days_check check (
    coalesce(array_ndims(default_reminder_days), 1) = 1
    and cardinality(default_reminder_days) <= 6
    and array_position(default_reminder_days, null) is null
    and 1 <= all (default_reminder_days)
    and 365 >= all (default_reminder_days)
  )
);

-- ---------------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------------

create table public.vehicles (
  id uuid primary key, -- client-generated
  user_id uuid not null references auth.users (id) on delete cascade,
  nickname text check (
    char_length(nickname) <= 50 and char_length(btrim(nickname)) >= 1
  ),
  plate_number text not null check (
    char_length(plate_number) between 1 and 15
    and plate_number ~ '^[A-Z0-9 -]+$'
  ),
  type text not null check (type in ('car', 'motorbike', 'three_wheeler', 'van')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Target of documents' composite FK (same-owner guarantee).
  constraint vehicles_id_user_id_key unique (id, user_id)
);

create index vehicles_user_id_updated_at_idx on public.vehicles (user_id, updated_at);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create table public.documents (
  id uuid primary key, -- client-generated
  user_id uuid not null references auth.users (id) on delete cascade,
  vehicle_id uuid not null,
  type text not null check (
    type in ('revenue_licence', 'insurance', 'emission_test', 'registration', 'custom')
  ),
  custom_name text check (
    char_length(custom_name) <= 50 and char_length(btrim(custom_name)) >= 1
  ),
  expiry_date date not null,
  reminder_days integer[] not null default '{30,7,1}',
  push_enabled boolean not null default true,
  email_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint documents_custom_name_required check (type <> 'custom' or custom_name is not null),
  constraint documents_reminder_days_check check (
    coalesce(array_ndims(reminder_days), 1) = 1
    and cardinality(reminder_days) <= 6
    and array_position(reminder_days, null) is null
    and 1 <= all (reminder_days)
    and 365 >= all (reminder_days)
  ),
  -- A document's vehicle must belong to the same user.
  constraint documents_vehicle_same_user_fkey foreign key (vehicle_id, user_id)
    references public.vehicles (id, user_id) on delete cascade
);

create index documents_user_id_updated_at_idx on public.documents (user_id, updated_at);
create index documents_vehicle_id_user_id_idx on public.documents (vehicle_id, user_id);

-- ---------------------------------------------------------------------------
-- reminders
-- ---------------------------------------------------------------------------

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  days_before integer not null check (days_before between 0 and 365),
  send_on date not null,
  channel text not null check (channel in ('push', 'email')),
  status text not null default 'scheduled' check (
    status in ('scheduled', 'sent', 'failed', 'skipped')
  ),
  sent_at timestamptz,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminders_document_days_channel_key unique (document_id, days_before, channel)
);

create index reminders_status_send_on_idx on public.reminders (status, send_on);
create index reminders_user_id_send_on_idx on public.reminders (user_id, send_on);

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  push_token text not null unique check (char_length(push_token) between 1 and 255),
  platform text not null check (platform in ('ios', 'android')),
  device_name text check (char_length(device_name) <= 100),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index devices_user_id_idx on public.devices (user_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger profiles_set_updated_at before insert or update on public.profiles
  for each row execute function public.set_updated_at();
create trigger vehicles_set_updated_at before insert or update on public.vehicles
  for each row execute function public.set_updated_at();
create trigger documents_set_updated_at before insert or update on public.documents
  for each row execute function public.set_updated_at();
create trigger reminders_set_updated_at before insert or update on public.reminders
  for each row execute function public.set_updated_at();
create trigger devices_set_updated_at before insert or update on public.devices
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Profile on sign-up
-- ---------------------------------------------------------------------------

create function public.handle_new_user()
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
    left(new.email, 254)
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Privileges: explicit, least privilege. anon gets nothing.
-- ---------------------------------------------------------------------------

revoke all on table
  public.profiles, public.vehicles, public.documents, public.reminders, public.devices
  from anon, authenticated;

grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.vehicles to authenticated;
grant select, insert, update, delete on table public.documents to authenticated;
grant select on table public.reminders to authenticated;
grant select, insert, update, delete on table public.devices to authenticated;

grant all on table
  public.profiles, public.vehicles, public.documents, public.reminders, public.devices
  to service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.documents enable row level security;
alter table public.reminders enable row level security;
alter table public.devices enable row level security;

create policy "profiles: owner select" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles: owner update" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "vehicles: owner all" on public.vehicles
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "documents: owner all" on public.documents
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.vehicles v
      where v.id = vehicle_id and v.user_id = (select auth.uid())
    )
  );

create policy "reminders: owner select" on public.reminders
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "devices: owner all" on public.devices
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
