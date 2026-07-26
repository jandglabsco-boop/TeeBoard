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
-- TeeBoard's app code treats those as manageable by anyone with the admin
-- link (same as before), so nothing breaks for existing tournaments.

-- Lets organizers remove a player from the admin "Edit team" panel. Safe to
-- re-run.
drop policy if exists "public delete team_members" on team_members;
create policy "public delete team_members" on team_members for delete using (true);

-- Scorecard "review & sign" flow: once a team signs off, their scorecard
-- locks and the leaderboard shows an "F" (finished) badge. Organizers can
-- reopen a signed scorecard from the admin panel if needed. Safe to re-run.
alter table teams add column if not exists signed_at timestamptz;
alter table teams add column if not exists signed_by text;
