-- kinetic: accounts, preferences and project history.
--
-- Videos never come here. The MP4 stays on whichever machine rendered it; this
-- schema stores the beat sheet, which is the contract every stage reads, so a
-- project can be reopened and re-rendered on another machine.
--
-- Paste this whole file into the Supabase SQL editor and run it once.

-- ---------------------------------------------------------------- profiles --
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  display_name text,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "update own profile"
  on public.profiles for update using (auth.uid() = id);

-- ------------------------------------------------------------- preferences --
create table if not exists public.preferences (
  user_id     uuid primary key references auth.users on delete cascade,
  theme       text not null default 'dark'  check (theme in ('dark', 'light')),
  effect      text not null default 'gradient'
              check (effect in ('gradient', 'clouds', 'fluid', 'aurora')),
  voice       text not null default 'af_heart',
  variant     smallint not null default 0 check (variant between 0 and 9),
  updated_at  timestamptz not null default now()
);

alter table public.preferences enable row level security;

create policy "read own preferences"
  on public.preferences for select using (auth.uid() = user_id);
create policy "insert own preferences"
  on public.preferences for insert with check (auth.uid() = user_id);
create policy "update own preferences"
  on public.preferences for update using (auth.uid() = user_id);

-- ---------------------------------------------------------------- projects --
-- One row per topic per account. `sheet` is the whole beat sheet, which is what
-- makes a project portable; `rendered_on` records which machines hold an MP4.
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  slug         text not null,
  topic        text not null,
  seed         bigint,
  variant      smallint,
  effect       text,
  duration_ms  integer,
  beat_count   smallint,
  word_count   smallint,
  sfx_count    smallint,
  sheet        jsonb,
  rendered_on  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, slug)
);

create index if not exists projects_user_updated_idx
  on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

create policy "read own projects"
  on public.projects for select using (auth.uid() = user_id);
create policy "insert own projects"
  on public.projects for insert with check (auth.uid() = user_id);
create policy "update own projects"
  on public.projects for update using (auth.uid() = user_id);
create policy "delete own projects"
  on public.projects for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------- triggers --
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists preferences_touch on public.preferences;
create trigger preferences_touch before update on public.preferences
  for each row execute function public.touch_updated_at();

-- A profile and a preferences row the moment someone signs up, so the app never
-- has to special-case a brand new account.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
    on conflict (id) do nothing;
  insert into public.preferences (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
