-- Corner: one-time setup for the sync space.
-- Paste all of this into Supabase → SQL Editor → New query, then press Run.
-- It creates ONE table that only ever holds locked (encrypted) text,
-- and rules so each signed-in person can only reach their own rows.

create table if not exists public.corner_docs (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  path       text        not null,
  iv         text,
  data       text        not null,
  updated_at timestamptz not null default now(),
  primary key (owner, path)
);

alter table public.corner_docs enable row level security;

drop policy if exists "Only the owner can read or change their rows" on public.corner_docs;
create policy "Only the owner can read or change their rows"
  on public.corner_docs
  for all
  to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- signed-out visitors get nothing at all
revoke all on public.corner_docs from anon;
grant select, insert, update, delete on public.corner_docs to authenticated;

-- live updates between devices
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'corner_docs') then
    alter publication supabase_realtime add table public.corner_docs;
  end if;
end $$;
