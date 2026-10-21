-- UWMathFinder Lab: tables and security policies.
--
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- It is safe to re-run (it drops and recreates the policies, triggers and grants, not the data).
--
-- Security model (see DECISIONS.md, "Insert-only anon key"):
--   * The page holds the public anon (publishable) key. Anyone can read it from the page source.
--   * With that key a visitor can INSERT rows into the three lab_ tables and nothing else:
--     no SELECT, UPDATE or DELETE, so nobody can read, change or wipe other people's answers.
--   * Row Level Security is on, with an INSERT policy only. On top of that the anon role is
--     granted INSERT on specific columns only, so it can't set created_at or other server fields.
--   * CHECK constraints repeat the browser's text rules (assets/js/validate.mjs), and triggers
--     cap how many rows one session id can insert.
--   * Only scripts/export.mjs reads the data, with the service-role (secret) key, which lives
--     in a local .env file and never in the browser.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ── tables ──────────────────────────────────────────────────────────────────

create table if not exists public.lab_queries (
  id              uuid primary key,                 -- made in the browser, so judgments can point at it
  session_id      uuid not null,                    -- random id in the contributor's localStorage
  task            text not null check (task in ('search', 'describe')),
  source          text not null check (source in ('human_blind', 'human_image_shown')),
  query           text not null check (
                    char_length(query) between 3 and 200
                    and query !~* '[^[:space:]@]+[[:space:]]*@[[:space:]]*[^[:space:]@]+\.[a-z]{2,}'   -- email
                    and query !~ '(\+?[0-9][[:space:].()-]*){10,}'                                    -- phone
                  ),
  course          text check (course in ('Math 120','Math 124','Math 125','Math 126','Math 207','Math 208','Math 224')),  -- the course they picked (null = skipped)
  scenario_id     text check (char_length(scenario_id) <= 40),
  -- search: the course results were limited to (null = all courses); describe: the shown question's course
  scenario_course text check (scenario_course in ('Math 120','Math 124','Math 125','Math 126','Math 207','Math 208','Math 224')),
  target_id       text check (target_id ~ '^q[0-9]{4,5}$'),   -- "describe": the question that was shown
  none_relevant   boolean,                          -- "search": the contributor chose "none of these"
  index_commit    text not null check (index_commit ~ '^[0-9a-f]{40}$'),
  app_version     text check (char_length(app_version) <= 20),
  is_test         boolean not null default false,   -- localhost or ?test=1; dropped by the export
  created_at      timestamptz not null default now(),
  constraint task_matches_source check (
    (task = 'search' and source = 'human_blind' and target_id is null)
    or (task = 'describe' and source = 'human_image_shown' and target_id is not null and none_relevant is null)
  )
);

create table if not exists public.lab_judgments (
  id              uuid primary key default gen_random_uuid(),
  query_id        uuid not null references public.lab_queries (id) on delete cascade,
  session_id      uuid not null,
  question_id     text not null check (question_id ~ '^q[0-9]{4,5}$'),
  position        smallint not null check (position between 1 and 5),   -- where it was shown (after shuffling)
  rating          text not null check (rating in ('wanted', 'related', 'not_relevant')),
  assistant_rank  integer check (assistant_rank > 0),   -- rank in the assistant's list, null if unranked
  words_rank      integer check (words_rank > 0),       -- rank in the word-overlap list, null if no overlap
  is_random       boolean not null default false,       -- the random same-course pick
  is_check        boolean not null default false,       -- attention check: should be "not_relevant"
  created_at      timestamptz not null default now(),
  unique (query_id, question_id)
);

create table if not exists public.lab_pairs (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null,
  query_ref       text not null check (char_length(query_ref) <= 40),    -- id in data/pair-queries.json
  query_source    text not null check (query_source in ('llm', 'human')),
  course          text check (course in ('Math 120','Math 124','Math 125','Math 126','Math 207','Math 208','Math 224')),
  left_id         text not null check (left_id ~ '^q[0-9]{4,5}$'),
  right_id        text not null check (right_id ~ '^q[0-9]{4,5}$'),
  left_system     text not null check (left_system in ('assistant', 'keyword_words')),
  right_system    text not null check (right_system in ('assistant', 'keyword_words')),
  choice          text not null check (choice in ('left', 'right', 'both', 'neither')),
  index_commit    text not null check (index_commit ~ '^[0-9a-f]{40}$'),
  app_version     text check (char_length(app_version) <= 20),
  is_test         boolean not null default false,
  created_at      timestamptz not null default now(),
  check (left_id <> right_id)
);

create index if not exists lab_queries_session   on public.lab_queries (session_id);
create index if not exists lab_judgments_session on public.lab_judgments (session_id);
create index if not exists lab_pairs_session     on public.lab_pairs (session_id);

-- ── per-session limits ──────────────────────────────────────────────────────
-- The browser stops at 40 tasks per session; these are the hard caps in case someone
-- skips the browser. The functions live in a schema the API doesn't expose and run as
-- their owner (security definer) so they can count rows the anon role can't see.

create schema if not exists lab_private;
revoke all on schema lab_private from public, anon, authenticated;

create or replace function lab_private.limit_queries() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.lab_queries where session_id = new.session_id) >= 60 then
    raise exception 'session limit reached';
  end if;
  return new;
end $$;

create or replace function lab_private.limit_judgments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.lab_judgments where query_id = new.query_id) >= 5 then
    raise exception 'too many judgments for one query';
  end if;
  if not exists (select 1 from public.lab_queries q
                 where q.id = new.query_id and q.session_id = new.session_id and q.task = 'search') then
    raise exception 'judgment must belong to a search query from the same session';
  end if;
  return new;
end $$;

create or replace function lab_private.limit_pairs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.lab_pairs where session_id = new.session_id) >= 60 then
    raise exception 'session limit reached';
  end if;
  return new;
end $$;

revoke all on all functions in schema lab_private from public, anon, authenticated;

drop trigger if exists limit_queries on public.lab_queries;
create trigger limit_queries before insert on public.lab_queries
  for each row execute function lab_private.limit_queries();
drop trigger if exists limit_judgments on public.lab_judgments;
create trigger limit_judgments before insert on public.lab_judgments
  for each row execute function lab_private.limit_judgments();
drop trigger if exists limit_pairs on public.lab_pairs;
create trigger limit_pairs before insert on public.lab_pairs
  for each row execute function lab_private.limit_pairs();

-- ── row level security: INSERT only ─────────────────────────────────────────

alter table public.lab_queries   enable row level security;
alter table public.lab_judgments enable row level security;
alter table public.lab_pairs     enable row level security;

drop policy if exists "anyone can insert" on public.lab_queries;
drop policy if exists "anyone can insert" on public.lab_judgments;
drop policy if exists "anyone can insert" on public.lab_pairs;
create policy "anyone can insert" on public.lab_queries   for insert to anon with check (true);
create policy "anyone can insert" on public.lab_judgments for insert to anon with check (true);
create policy "anyone can insert" on public.lab_pairs     for insert to anon with check (true);
-- No SELECT, UPDATE or DELETE policies: with RLS on, those are denied for anon.

-- ── table privileges: also INSERT only, and only on the columns the browser sends ──

revoke all on public.lab_queries, public.lab_judgments, public.lab_pairs from anon, authenticated;

grant insert (id, session_id, task, source, query, course, scenario_id, scenario_course,
              target_id, none_relevant, index_commit, app_version, is_test)
  on public.lab_queries to anon;
grant insert (query_id, session_id, question_id, position, rating, assistant_rank, words_rank,
              is_random, is_check)
  on public.lab_judgments to anon;
grant insert (session_id, query_ref, query_source, course, left_id, right_id, left_system,
              right_system, choice, index_commit, app_version, is_test)
  on public.lab_pairs to anon;

-- ── check it worked ─────────────────────────────────────────────────────────
-- Expect three rows, each with rowsecurity = true and one policy, cmd = INSERT:
select c.relname as table_name, c.relrowsecurity as rowsecurity,
       (select string_agg(p.cmd, ',') from pg_policies p where p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('lab_queries', 'lab_judgments', 'lab_pairs');
