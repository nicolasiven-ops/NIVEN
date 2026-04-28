-- MOD_002 NET_FORGE — cloud persistence
--
-- One row per network map. The whole map (devices, links, stacks, vlans,
-- zones, view) lives in the `data` jsonb column. Per-user RLS via auth.uid().
--
-- Applied via Supabase Management API on 2026-04-28. This file is the
-- canonical source if you ever need to reproduce the schema.

create table if not exists public.m002_maps (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.m002_maps enable row level security;

drop policy if exists "m002_maps owner select" on public.m002_maps;
drop policy if exists "m002_maps owner insert" on public.m002_maps;
drop policy if exists "m002_maps owner update" on public.m002_maps;
drop policy if exists "m002_maps owner delete" on public.m002_maps;

create policy "m002_maps owner select" on public.m002_maps
  for select using (user_id = auth.uid());
create policy "m002_maps owner insert" on public.m002_maps
  for insert with check (user_id = auth.uid());
create policy "m002_maps owner update" on public.m002_maps
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "m002_maps owner delete" on public.m002_maps
  for delete using (user_id = auth.uid());

-- Auto-bump updated_at on every row update.
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists m002_maps_set_updated_at on public.m002_maps;
create trigger m002_maps_set_updated_at
  before update on public.m002_maps
  for each row execute function public.tg_set_updated_at();

create index if not exists m002_maps_user_idx
  on public.m002_maps(user_id, updated_at desc);
