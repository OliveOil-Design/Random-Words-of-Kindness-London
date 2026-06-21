-- Kind Words, London — Supabase schema
-- Safe to re-run: uses if-not-exists / create-or-replace, and seeds only when empty.

-- 1. The wall ---------------------------------------------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  approved    boolean not null default false,   -- false = waiting for human review
  reports     int not null default 0,
  created_at  timestamptz not null default now()
);

-- add reports column if upgrading from an earlier version
alter table public.messages add column if not exists reports int not null default 0;

-- 2. Row Level Security -----------------------------------------------------
-- Visitors (anon key) may READ approved messages and nothing else. All writes
-- happen through controlled paths: the submit edge function (service role) and
-- the report_message function (security definer) below.
alter table public.messages enable row level security;

drop policy if exists "read approved messages" on public.messages;
create policy "read approved messages"
  on public.messages
  for select
  using (approved = true);

-- 3. Random message function ------------------------------------------------
create or replace function public.get_random_message(exclude_id uuid default null)
returns setof public.messages
language sql
stable
as $$
  select *
  from public.messages
  where approved = true
    and (exclude_id is null or id <> exclude_id)
  order by random()
  limit 1;
$$;

grant execute on function public.get_random_message(uuid) to anon;

-- 4. Reporting --------------------------------------------------------------
-- A reported message is pulled from the wall immediately (approved = false)
-- and counted, so a human can review it in the queue. security definer lets
-- anon trigger this one controlled write without any direct table access.
create or replace function public.report_message(msg_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.messages
     set reports  = reports + 1,
         approved = false
   where id = msg_id;
end;
$$;

grant execute on function public.report_message(uuid) to anon;

-- 5. Rate-limit log ---------------------------------------------------------
-- One row per submission attempt, keyed on a SALTED HASH of the IP (never the
-- raw IP). Used only to throttle submissions; old rows are pruned by the
-- function on each call. RLS is on with no anon policies, so only the service
-- role (the edge function) can touch it.
create table if not exists public.submission_log (
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists submission_log_lookup
  on public.submission_log (ip_hash, created_at);

alter table public.submission_log enable row level security;

-- 6. Seed messages (only if the wall is empty) ------------------------------
insert into public.messages (text, approved)
select v.text, true
from (values
  ('You made it through every hard day so far. Today is no different. Keep going.'),
  ('Whoever you are, on whatever bus or bench you''re reading this — I hope something lovely surprises you today.'),
  ('You don''t have to have it all figured out. Nobody on this whole island does.'),
  ('Someone, somewhere, is glad you exist. Even strangers. Especially strangers.'),
  ('Rest is allowed. You''re a person, not a to-do list.'),
  ('If today feels heavy, just carry the next ten minutes. Then the next. That''s enough.'),
  ('London can feel huge and lonely. You''re not the only one feeling that — which is a strange kind of together.')
) as v(text)
where not exists (select 1 from public.messages);

-- Review queue (reported or held messages):
--   select * from public.messages where approved = false order by reports desc, created_at desc;
-- Restore one:  update public.messages set approved = true, reports = 0 where id = '...';
-- Remove one:   delete from public.messages where id = '...';
