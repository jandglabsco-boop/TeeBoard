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

create policy "public read tournaments" on tournaments for select using (true);
create policy "public insert tournaments" on tournaments for insert with check (true);
create policy "public update tournaments" on tournaments for update using (true);

create policy "public read teams" on teams for select using (true);
create policy "public insert teams" on teams for insert with check (true);
create policy "public update teams" on teams for update using (true);

create policy "public read team_members" on team_members for select using (true);
create policy "public insert team_members" on team_members for insert with check (true);

create policy "public read scores" on scores for select using (true);
create policy "public insert scores" on scores for insert with check (true);
create policy "public update scores" on scores for update using (true);

-- Enable realtime updates so leaderboards refresh live on every phone
alter publication supabase_realtime add table scores;
alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table team_members;
