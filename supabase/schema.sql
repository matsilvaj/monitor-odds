create extension if not exists pgcrypto;

create table if not exists bookmakers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  api_football_league_id bigint not null unique,
  name text not null,
  slug text not null unique,
  country text,
  season integer,
  enabled boolean not null default true,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  api_football_team_id bigint not null unique,
  name text not null,
  normalized_name text not null,
  logo_url text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fixtures (
  id uuid primary key default gen_random_uuid(),
  api_football_fixture_id bigint not null unique,
  league_id uuid not null references leagues(id) on delete cascade,
  home_team_id uuid not null references teams(id) on delete restrict,
  away_team_id uuid not null references teams(id) on delete restrict,
  name text not null,
  home_team text not null,
  away_team text not null,
  normalized_home_team text not null,
  normalized_away_team text not null,
  starts_at timestamptz not null,
  date_key date not null,
  status text not null default 'NS',
  round text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bookmaker_event_links (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  bookmaker_slug text not null references bookmakers(slug) on delete cascade,
  external_event_id bigint not null,
  bookmaker_event_name text not null,
  bookmaker_home_team text,
  bookmaker_away_team text,
  normalized_bookmaker_home_team text,
  normalized_bookmaker_away_team text,
  starts_at timestamptz,
  match_confidence_score numeric(4, 3) not null default 0,
  source_url text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bookmaker_slug, external_event_id)
);

create table if not exists odds (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references fixtures(id) on delete cascade,
  bookmaker_slug text not null references bookmakers(slug) on delete cascade,
  market_code text not null,
  market_name text not null,
  selection text not null,
  price numeric(12, 4) not null,
  pa_category text not null check (pa_category in ('COM_PA', 'SEM_PA')),
  confidence_score numeric(4, 3) not null default 1,
  raw_market_name text,
  raw_label text,
  raw_odd_type text,
  source_odd_id bigint,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fixture_id, bookmaker_slug, market_code, selection, pa_category, source_odd_id)
);

create table if not exists fixture_sync_runs (
  id uuid primary key default gen_random_uuid(),
  date_key date not null,
  source text not null,
  status text not null,
  league_ids_hash text,
  fixtures_seen integer not null default 0,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (date_key, source)
);

alter table fixture_sync_runs add column if not exists league_ids_hash text;

create table if not exists collection_logs (
  id uuid primary key default gen_random_uuid(),
  bookmaker_slug text not null,
  level text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists bookmaker_sessions (
  bookmaker_slug text primary key references bookmakers(slug) on delete cascade,
  x_net_sync_term text not null,
  cookie text not null,
  captured_from text,
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fixtures_search_idx on fixtures using gin (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(home_team, '') || ' ' || coalesce(away_team, ''))
);

create index if not exists fixtures_starts_at_idx on fixtures (starts_at);
create index if not exists fixtures_date_key_idx on fixtures (date_key);
create index if not exists fixtures_league_id_idx on fixtures (league_id);
create index if not exists teams_normalized_name_idx on teams (normalized_name);
create index if not exists odds_fixture_id_idx on odds (fixture_id);
create index if not exists bookmaker_event_links_fixture_id_idx on bookmaker_event_links (fixture_id);
create index if not exists bookmaker_sessions_expires_at_idx on bookmaker_sessions (expires_at);
