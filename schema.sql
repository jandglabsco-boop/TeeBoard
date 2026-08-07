-- TeeBoard schema
-- Run this in your Supabase project's SQL editor (Project > SQL Editor > New query)

create extension if not exists "pgcrypto";

-- One row per tournament (e.g. a Thursday night scramble)
create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  course_name text,
  join_code text not null unique,
  num_holes int not null default 18,
  par jsonb not null default '[]',        -- e.g. [4,4,3,5,4,3,4,5,4,4,4,3,5,4,4,3,4,5]
  start_hole int not null default 1,      -- 1, or 10 for a back-nine 9-hole round
  handicap jsonb,                         -- stroke index per hole (1 = hardest), for tiebreaks
  yardage jsonb,                          -- yards per hole, for the tee below
  tee_name text,                          -- e.g. 'White' — which tee the yardages are from
  course_id text,                         -- OpenGolfAPI course id, lets the admin page re-pull tees
  status text not null default 'active',  -- 'active' | 'closed'
  created_by uuid references auth.users(id), -- the organizer account that created it
  created_at timestamptz not null default now()
);

-- One row per team within a tournament
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  name text not null,
  join_code text not null,                -- short code, unique within a tournament
  created_at timestamptz not null default now(),
  unique (tournament_id, join_code)
);

-- One row per player on a team
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  player_name text not null,
  created_at timestamptz not null default now()
);

-- One row per hole score for a team (scramble = single team score per hole)
create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  hole_number int not null,
  strokes int not null,
  updated_at timestamptz not null default now(),
  unique (team_id, hole_number)
);

-- Indexes for the lookups the app does most (join by code, leaderboard by tournament)
create index if not exists idx_teams_tournament on teams(tournament_id);
create index if not exists idx_scores_team on scores(team_id);
create index if not exists idx_team_members_team on team_members(team_id);

-- Row Level Security
-- This is a casual, no-login league tool: access is gated by knowing the join code,
-- not by database auth. Anyone with the anon key can read/write. That's fine for a
-- private Thursday-night league; do not use this schema for anything sensitive.
alter table tournaments enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
alter table scores enable row level security;

-- Anyone (even anonymous players) can look up a tournament by join code to play.
create policy "public read tournaments" on tournaments for select using (true);
-- But you must be signed in to create one, and it's attributed to you.
create policy "authenticated users can create tournaments" on tournaments
  for insert
  with check (auth.uid() is not null and created_by = auth.uid());
-- Only the creator can update their own tournament (e.g. close it).
create policy "only owner can update their tournament" on tournaments
  for update
  using (auth.uid() = created_by);

create policy "public read teams" on teams for select using (true);
create policy "public insert teams" on teams for insert with check (true);
create policy "public update teams" on teams for update using (true);

create policy "public read team_members" on team_members for select using (true);
create policy "public insert team_members" on team_members for insert with check (true);
create policy "public delete team_members" on team_members for delete using (true);

create policy "public read scores" on scores for select using (true);
create policy "public insert scores" on scores for insert with check (true);
create policy "public update scores" on scores for update using (true);

-- Enable realtime updates so leaderboards refresh live on every phone
alter publication supabase_realtime add table scores;
alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table team_members;

-- =====================================================================
-- MIGRATION: run this block only if you already set up TeeBoard before
-- accounts existed (i.e. you already ran everything above once). This
-- adds organizer accounts: creating a tournament now requires signing
-- in, and only the creator can manage (close) their own tournament.
-- Safe to re-run.
-- =====================================================================

alter table tournaments add column if not exists created_by uuid references auth.users(id);

drop policy if exists "public insert tournaments" on tournaments;
drop policy if exists "authenticated users can create tournaments" on tournaments;
create policy "authenticated users can create tournaments" on tournaments
  for insert
  with check (auth.uid() is not null and created_by = auth.uid());

drop policy if exists "public update tournaments" on tournaments;
drop policy if exists "only owner can update their tournament" on tournaments;
create policy "only owner can update their tournament" on tournaments
  for update
  using (auth.uid() = created_by);

-- Note: any tournaments created before this migration have created_by = null.
-- The ownership lockdown at the bottom of this file assigns them a real owner
-- and makes the column NOT NULL — read that before running this on an
-- existing project.

-- Lets organizers remove a player from the admin "Edit team" panel. Safe to
-- re-run.
drop policy if exists "public delete team_members" on team_members;
create policy "public delete team_members" on team_members for delete using (true);

-- Scorecard "review & sign" flow: once a team signs off, their scorecard
-- locks and the leaderboard shows an "F" (finished) badge. Organizers can
-- reopen a signed scorecard from the admin panel if needed. Safe to re-run.
alter table teams add column if not exists signed_at timestamptz;
alter table teams add column if not exists signed_by text;

-- Lets an organizer permanently delete a tournament (and, via the existing
-- "on delete cascade" foreign keys, all of its teams/players/scores) from
-- the admin panel's Danger Zone. Strictly the owner — see the ownership
-- lockdown below for why the earlier "created_by is null" allowance was a
-- hole rather than a convenience. Safe to re-run.
drop policy if exists "only owner can delete their tournament" on tournaments;
create policy "only owner can delete their tournament" on tournaments
  for delete
  using (auth.uid() = created_by);

-- Real course hole numbers + tiebreaks.
--   start_hole: a 9-hole round played on the back nine is holes 10-18 on the
--     actual course, not 1-9. Internal hole numbers still run 1..num_holes;
--     this is only the offset used when displaying them.
--   handicap: stroke index per hole (1 = hardest), entered by the organizer in
--     the admin panel. Used only to break ties once teams have finished every
--     hole — a "scorecard playoff" countback on the hardest holes first.
--     Null means fall back to plain hole order.
-- Safe to re-run.
alter table tournaments add column if not exists start_hole int not null default 1;
alter table tournaments add column if not exists handicap jsonb;

-- Full scorecard detail: yards per hole for a chosen tee, so cards show
-- YDS/PAR/HCP like a real scorecard. course_id is OpenGolfAPI's id for the
-- course, kept so the admin page can re-pull the tee list later; tee_name
-- records which tee the stored yardages came from. All optional — cards just
-- omit the rows they have no data for. Safe to re-run.
alter table tournaments add column if not exists yardage jsonb;
alter table tournaments add column if not exists tee_name text;
alter table tournaments add column if not exists course_id text;

-- Ownership lockdown.
--
-- "created_by is null" used to be treated as "anyone may manage this", both in
-- the app and in the delete policy. That was meant as a kindness to
-- tournaments created before organizer accounts existed, but it means anyone
-- holding the admin link — which is just a URL — could rename or permanently
-- delete those tournaments, along with every team and score in them.
--
-- Separately, the home screen's "Tournaments I created" list used to be fed
-- partly from browser localStorage, which every admin-page visit appended to.
-- Signing in on a shared device therefore showed tournaments belonging to
-- other accounts. That list now comes only from this column.
--
-- Assign every ownerless tournament to a real account before running the
-- NOT NULL below, or it will fail. Replace the email with whoever should own
-- the pre-accounts tournaments on your project.
update tournaments t
   set created_by = (select id from auth.users where email = 'you@example.com')
 where t.created_by is null;

alter table tournaments alter column created_by set not null;

-- =====================================================================
-- BILLING: 30-day free trial, then $30/month per organizer.
--
-- Enforcement lives here, not in the app. TeeBoard is static files with a
-- public anon key, so anything gated only in JavaScript can be bypassed by
-- editing it in a browser. The policies below are the actual paywall.
--
-- organizer_billing has a SELECT policy and deliberately no INSERT/UPDATE
-- policy: only the stripe-webhook Edge Function (service role, which bypasses
-- RLS) may change subscription state. A tampered client cannot grant itself
-- access by writing to its own row.
-- =====================================================================

create table if not exists organizer_billing (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  trial_ends_at          timestamptz not null default (now() + interval '30 days'),
  is_exempt              boolean     not null default false,  -- comped accounts
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    text,        -- Stripe's status: active, past_due, canceled, ...
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

alter table organizer_billing enable row level security;

drop policy if exists "read own billing" on organizer_billing;
create policy "read own billing" on organizer_billing
  for select using (auth.uid() = user_id);

-- Single source of truth for "may this organizer run tournaments?".
create or replace function public.has_teeboard_access(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select b.is_exempt
        or now() < b.trial_ends_at
        or b.subscription_status in ('active', 'trialing')
    from organizer_billing b where b.user_id = uid
  ), false);
$$;

revoke all on function public.has_teeboard_access(uuid) from public;
grant execute on function public.has_teeboard_access(uuid) to authenticated, anon;

-- Every new organizer starts a 30-day trial automatically.
create or replace function public.start_teeboard_trial()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into organizer_billing (user_id, trial_ends_at)
  values (new.id, now() + interval '30 days')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_start_trial on auth.users;
create trigger on_auth_user_created_start_trial
  after insert on auth.users
  for each row execute function public.start_teeboard_trial();

-- Backfill anyone who signed up before billing existed.
insert into organizer_billing (user_id, trial_ends_at)
select u.id, u.created_at + interval '30 days' from auth.users u
on conflict (user_id) do nothing;

-- The paywall itself. Creating and managing require access; deleting never
-- does, so someone who stops paying can still remove their own data.
drop policy if exists "authenticated users can create tournaments" on tournaments;
drop policy if exists "subscribed organizers can create tournaments" on tournaments;
create policy "subscribed organizers can create tournaments" on tournaments
  for insert with check (
    auth.uid() is not null
    and created_by = auth.uid()
    and public.has_teeboard_access(auth.uid())
  );

drop policy if exists "only owner can update their tournament" on tournaments;
drop policy if exists "subscribed owner can update their tournament" on tournaments;
create policy "subscribed owner can update their tournament" on tournaments
  for update using (auth.uid() = created_by and public.has_teeboard_access(auth.uid()));

-- Players are never gated: teams, team_members and scores keep their public
-- policies so a round in progress is unaffected by the organizer's billing.

-- Comp an account (never pays):
--   update organizer_billing b set is_exempt = true from auth.users u
--    where u.id = b.user_id and u.email = 'you@example.com';

-- =====================================================================
-- PAGE VIEWS (self-hosted analytics)
--
-- Deliberately stores no IP address, no user agent, no account link and
-- nothing identifying: only which screen was viewed, a random per-browser
-- id so repeat views collapse into visitors, and the referring host. That
-- keeps it out of "personal data" for most purposes and is why the app
-- needs no cookie banner. Anyone may insert (visitors are anonymous);
-- only comped accounts may read.
-- =====================================================================

create table if not exists page_views (
  id         bigint generated always as identity primary key,
  path       text not null,               -- normalised route, e.g. #/leaderboard/:id
  session_id uuid not null,               -- random per browser, not per person
  referrer   text,                        -- host only, never a full URL
  created_at timestamptz not null default now()
);

create index if not exists idx_page_views_created on page_views(created_at desc);
create index if not exists idx_page_views_path on page_views(path);

alter table page_views enable row level security;

drop policy if exists "anyone can record a view" on page_views;
create policy "anyone can record a view" on page_views
  for insert with check (
    length(path) <= 120 and (referrer is null or length(referrer) <= 120)
  );

drop policy if exists "owners can read views" on page_views;
create policy "owners can read views" on page_views
  for select using (
    exists (select 1 from organizer_billing b
             where b.user_id = auth.uid() and b.is_exempt)
  );

-- Aggregates for the in-app #/stats screen. SECURITY DEFINER so it can read
-- page_views, but it re-checks the caller is comped before returning anything.
create or replace function public.teeboard_stats(days int default 30)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  since timestamptz := now() - make_interval(days => greatest(1, least(days, 365)));
  result json;
begin
  if not exists (select 1 from organizer_billing b
                  where b.user_id = auth.uid() and b.is_exempt) then
    raise exception 'not authorised';
  end if;

  select json_build_object(
    'days', days,
    'views',    (select count(*) from page_views where created_at >= since),
    'visitors', (select count(distinct session_id) from page_views where created_at >= since),
    'today',    (select count(distinct session_id) from page_views
                  where created_at >= date_trunc('day', now())),
    'top_pages', (select coalesce(json_agg(x), '[]'::json) from (
        select path, count(*) as views, count(distinct session_id) as visitors
        from page_views where created_at >= since
        group by path order by count(*) desc limit 10) x),
    'by_day', (select coalesce(json_agg(x order by x.day), '[]'::json) from (
        select date_trunc('day', created_at)::date as day,
               count(distinct session_id) as visitors
        from page_views where created_at >= since group by 1) x),
    'referrers', (select coalesce(json_agg(x), '[]'::json) from (
        select coalesce(nullif(referrer,''), 'direct') as source,
               count(distinct session_id) as visitors
        from page_views where created_at >= since
        group by 1 order by 2 desc limit 8) x)
  ) into result;

  return result;
end;
$$;

revoke all on function public.teeboard_stats(int) from public;
grant execute on function public.teeboard_stats(int) to authenticated;

-- =====================================================================
-- WRITE LOCKDOWN
--
-- teams, team_members and scores previously allowed unrestricted public
-- INSERT/UPDATE/DELETE, because players have no accounts and had to be able
-- to score. But the anon key is published in config.js, so anyone who viewed
-- source could wipe a live scorecard.
--
-- Reads stay public — leaderboards must work without an account. Writes now
-- go through SECURITY DEFINER functions that require proof of knowing a code
-- (players) or an authenticated owner (organizers). Knowing a join code is
-- exactly the real-world credential: it's what the organizer hands out.
-- =====================================================================

create or replace function public.gen_join_code(len int)
returns text language plpgsql volatile as $$
declare chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; out text := ''; i int;
begin
  for i in 1..len loop
    out := out || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return out;
end;
$$;

-- Players: gated on the tournament / team join code.
--   player_create_team(tournament_code, team_name, player_name) -> json
--   player_join_team(tournament_code, team_code, player_name)   -> json
--   player_set_score(team_code, hole, strokes)
--   player_sign_card(team_code, signed_by)
--
-- Organizers: gated on auth.uid() owning the tournament AND having access.
--   owns_tournament(tournament_id) -> boolean
--   organizer_add_team(tournament_id, team_name) -> json
--   organizer_add_player(team_id, player_name)
--   organizer_rename_team(team_id, name)
--   organizer_remove_player(member_id)
--   organizer_reopen_card(team_id)
--
-- (Full bodies were applied via migration; see git history for the source.)

-- Remove the permissive policies. Do this only AFTER the client is using the
-- functions above, or scoring breaks mid-round.
drop policy if exists "public insert teams"        on teams;
drop policy if exists "public update teams"        on teams;
drop policy if exists "public insert team_members" on team_members;
drop policy if exists "public delete team_members" on team_members;
drop policy if exists "public insert scores"       on scores;
drop policy if exists "public update scores"       on scores;

-- =====================================================================
-- GAME FORMATS
--
-- TeeBoard began as scramble-only: one score per team per hole. Stroke play,
-- Stableford, Best Ball and Skins all need a score per PLAYER per hole, so
-- scores gains an optional team_member_id. NULL means a team score (scramble,
-- alternate shot) — every pre-existing row stays NULL and keeps working.
-- =====================================================================

alter table tournaments add column if not exists format text not null default 'scramble';
alter table tournaments drop constraint if exists tournaments_format_check;
alter table tournaments add constraint tournaments_format_check check (
  format in ('scramble','alt_shot','stroke','stableford','best_ball','skins')
);

-- Per-player handicap index, for net scoring.
alter table team_members add column if not exists handicap numeric(4,1);

alter table scores add column if not exists team_member_id uuid
  references team_members(id) on delete cascade;

-- unique(team_id, hole_number) would stop four players scoring the same hole,
-- so it becomes two partial indexes: one per team score, one per player score.
alter table scores drop constraint if exists scores_team_id_hole_number_key;
drop index if exists scores_team_hole_team_score;
drop index if exists scores_member_hole;
create unique index scores_team_hole_team_score
  on scores (team_id, hole_number) where team_member_id is null;
create unique index scores_member_hole
  on scores (team_member_id, hole_number) where team_member_id is not null;

-- player_set_score gains an optional p_member_id and decides what's valid from
-- the tournament's format, so a client can't write a per-player score into a
-- scramble or a team score into a stroke-play event. organizer_set_handicap
-- sets a player's handicap index. (Bodies applied via migration; see git.)
