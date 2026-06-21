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
  logo_url text,
  country_flag_url text,
  season integer,
  enabled boolean not null default true,
  deleted_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table leagues add column if not exists logo_url text;
alter table leagues add column if not exists country_flag_url text;
alter table leagues add column if not exists deleted_at timestamptz;

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

create table if not exists bookmaker_league_links (
  id uuid primary key default gen_random_uuid(),
  bookmaker_slug text not null references bookmakers(slug) on delete cascade,
  api_football_league_id bigint not null,
  league_name text not null,
  league_country text,
  source_url text not null,
  bookmaker_league_name text,
  source text not null default 'discovered',
  raw jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bookmaker_slug, api_football_league_id)
);

create table if not exists bookmaker_league_url_requests (
  id uuid primary key default gen_random_uuid(),
  bookmaker_slug text not null references bookmakers(slug) on delete cascade,
  api_football_league_id bigint not null,
  league_name text not null,
  league_country text,
  mode text not null check (mode in ('add', 'update')),
  reason text not null check (reason in ('league-not-found', 'saved-url-failed')),
  previous_url text,
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  resolved_url text,
  resolved_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bookmaker_slug, api_football_league_id)
);

create table if not exists bookmaker_payload_cache (
  bookmaker_slug text not null references bookmakers(slug) on delete cascade,
  endpoint text not null,
  url text not null,
  pd text,
  body text not null,
  body_length integer not null default 0,
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bookmaker_slug, endpoint, url)
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
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fixture_id, bookmaker_slug, market_code, selection, pa_category, source_odd_id)
);

alter table odds add column if not exists last_seen_at timestamptz not null default now();
update odds
set last_seen_at = coalesce(last_seen_at, updated_at, now());

create or replace function set_database_updated_at()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and TG_TABLE_NAME = 'odds'
     and (to_jsonb(new) - 'updated_at' - 'last_seen_at') = (to_jsonb(old) - 'updated_at' - 'last_seen_at') then
    new.updated_at = old.updated_at;
    return new;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists odds_set_database_updated_at on odds;
create trigger odds_set_database_updated_at
before insert or update on odds
for each row
execute function set_database_updated_at();

drop trigger if exists bookmaker_event_links_set_database_updated_at on bookmaker_event_links;
create trigger bookmaker_event_links_set_database_updated_at
before insert or update on bookmaker_event_links
for each row
execute function set_database_updated_at();

update odds
set updated_at = now()
where updated_at > now();

update bookmaker_event_links
set updated_at = now()
where updated_at > now();

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

create table if not exists bookmaker_event_snapshots (
  id uuid primary key default gen_random_uuid(),
  bookmaker_slug text not null references bookmakers(slug) on delete cascade,
  external_event_id bigint not null,
  league_api_football_id bigint,
  league_name text,
  league_country text,
  event_name text not null,
  home_team text,
  away_team text,
  normalized_home_team text,
  normalized_away_team text,
  starts_at timestamptz,
  date_key date,
  source_url text,
  markets jsonb not null default '[]'::jsonb,
  raw_text text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bookmaker_slug, external_event_id)
);

create table if not exists bookmaker_collection_state (
  bookmaker_slug text primary key references bookmakers(slug) on delete cascade,
  status text not null default 'idle',
  last_started_at timestamptz,
  last_finished_at timestamptz,
  next_run_at timestamptz,
  lease_until timestamptz,
  last_error text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function try_acquire_bookmaker_collection_lock(
  p_bookmaker_slug text,
  p_lease_until timestamptz
) returns boolean
language plpgsql
as $$
declare
  acquired boolean;
begin
  insert into bookmaker_collection_state (bookmaker_slug, status, lease_until, last_started_at, updated_at)
  values (p_bookmaker_slug, 'running', p_lease_until, now(), now())
  on conflict (bookmaker_slug) do update
    set status = 'running',
        lease_until = p_lease_until,
        last_started_at = now(),
        updated_at = now()
    where bookmaker_collection_state.lease_until is null
       or bookmaker_collection_state.lease_until < now()
       or bookmaker_collection_state.status <> 'running'
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create index if not exists fixtures_search_idx on fixtures using gin (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(home_team, '') || ' ' || coalesce(away_team, ''))
);

create index if not exists fixtures_starts_at_idx on fixtures (starts_at);
create index if not exists fixtures_date_key_idx on fixtures (date_key);
create index if not exists fixtures_league_id_idx on fixtures (league_id);
create index if not exists teams_normalized_name_idx on teams (normalized_name);
create index if not exists odds_fixture_id_idx on odds (fixture_id);
create index if not exists odds_bookmaker_market_fixture_idx on odds (bookmaker_slug, market_code, fixture_id);
create index if not exists bookmaker_event_links_fixture_id_idx on bookmaker_event_links (fixture_id);
create index if not exists bookmaker_event_links_bookmaker_fixture_idx on bookmaker_event_links (bookmaker_slug, fixture_id);
create index if not exists bookmaker_league_links_slug_league_idx on bookmaker_league_links (bookmaker_slug, api_football_league_id);
create index if not exists bookmaker_league_url_requests_status_idx on bookmaker_league_url_requests (status, updated_at);
create index if not exists bookmaker_league_url_requests_slug_league_idx on bookmaker_league_url_requests (bookmaker_slug, api_football_league_id);
create index if not exists bookmaker_payload_cache_expires_at_idx on bookmaker_payload_cache (expires_at);
create index if not exists bookmaker_payload_cache_bookmaker_endpoint_idx on bookmaker_payload_cache (bookmaker_slug, endpoint);
create index if not exists bookmaker_event_snapshots_bookmaker_date_idx on bookmaker_event_snapshots (bookmaker_slug, date_key);
create index if not exists bookmaker_event_snapshots_league_idx on bookmaker_event_snapshots (league_api_football_id);
create index if not exists bookmaker_collection_state_next_run_idx on bookmaker_collection_state (next_run_at);

drop view if exists public.public_odds_feed;
drop view if exists public.public_odds_snapshot;
drop view if exists public.public_odds_fixtures;
drop view if exists public.public_odds_feed_compact;
drop view if exists public.public_odds_feed_status;

create view public.public_odds_feed_status
with (security_invoker = true)
as
with upcoming_fixtures as (
  select
    f.id,
    greatest(f.updated_at, l.updated_at) as fixture_version
  from fixtures f
  join leagues l on l.id = f.league_id
  where f.starts_at > now()
    and l.enabled = true
),
upcoming_odds as (
  select
    o.fixture_id,
    greatest(o.updated_at, o.last_seen_at) as odds_version
  from odds o
  join upcoming_fixtures uf on uf.id = o.fixture_id
)
select
  (select max(fixture_version) from upcoming_fixtures) as fixtures_version,
  (select max(odds_version) from upcoming_odds) as odds_version,
  (select max(odds_version) from upcoming_odds) as latest_odd_updated_at,
  (select max(odds_version) from upcoming_odds) as latest_odd_seen_at,
  (select count(*) from upcoming_fixtures) as upcoming_fixture_count,
  (select count(*) from upcoming_odds) as odd_count
;

create view public.public_odds_fixtures
with (security_invoker = true)
as
select
  f.id as fixture_id,
  f.api_football_fixture_id,
  f.name as fixture_name,
  f.home_team,
  f.away_team,
  f.starts_at,
  f.date_key,
  f.status,
  f.round,
  l.name as league_name,
  l.slug as league_slug,
  l.country as league_country,
  l.logo_url as league_logo_url,
  l.country_flag_url as league_country_flag_url,
  greatest(f.updated_at, l.updated_at) as fixture_updated_at
from fixtures f
join leagues l on l.id = f.league_id
where f.starts_at > now()
  and l.enabled = true;

create view public.public_odds_snapshot
with (security_invoker = true)
as
select
  f.id as fixture_id,
  max(o.updated_at) as latest_odd_updated_at,
  max(o.last_seen_at) as latest_odd_seen_at,
  jsonb_agg(
    jsonb_build_object(
      'bookmaker_slug', o.bookmaker_slug,
      'bookmaker_name', b.name,
      'bookmaker_event_url', coalesce(
        bel.source_url,
        case o.bookmaker_slug
          when 'apostabet' then 'https://aposta.bet.br/'
          when 'bet7k' then 'https://7k.bet.br/'
          when 'betano' then 'https://www.betano.bet.br/'
          when 'betboom' then 'https://betboom.bet.br/'
          when 'betesporte' then 'https://betesporte.bet.br/'
          when 'betfair' then 'https://www.betfair.bet.br/'
          when 'betfast' then 'https://betfast.bet.br/'
          when 'betmgm' then 'https://www.betmgm.bet.br/'
          when 'betnacional' then 'https://betnacional.bet.br/'
          when 'betvip' then 'https://betvip.bet.br/'
          when 'br4bet' then 'https://br4.bet.br/'
          when 'casadeapostas' then 'https://casadeapostas.bet.br/'
          when 'esportesdasorte' then 'https://esportesdasorte.bet.br/'
          when 'esportiva' then 'https://esportiva.bet.br/'
          when 'estrelabet' then 'https://www.estrelabet.bet.br/'
          when 'jogodeouro' then 'https://jogodeouro.bet.br/'
          when 'kto' then 'https://www.kto.bet.br/'
          when 'lotogreen' then 'https://lotogreen.bet.br/'
          when 'novibet' then 'https://www.novibet.bet.br/'
          when 'segurobet' then 'https://www.seguro.bet.br/'
          when 'sportingbet' then 'https://www.sportingbet.bet.br/'
          when 'sportybet' then 'https://www.sporty.bet.br/'
          when 'superbet' then 'https://superbet.bet.br/'
          when 'tradeball' then 'https://bolsadeaposta.bet.br/tradeball/'
          when 'vaidebet' then 'https://vaidebet.bet.br/'
          when 'versusbet' then 'https://www.versus.bet.br/'
          when 'vupibet' then 'https://www.vupi.bet.br/'
          else null
        end
      ),
      'market_code', o.market_code,
      'market_name', o.market_name,
      'selection', o.selection,
      'price', o.price,
      'pa_category', o.pa_category,
      'confidence_score', o.confidence_score,
      'odd_updated_at', o.updated_at,
      'odd_last_seen_at', o.last_seen_at
    )
    order by o.bookmaker_slug, o.market_code, o.pa_category, o.selection
  ) as odds
from fixtures f
join leagues l on l.id = f.league_id
join odds o on o.fixture_id = f.id
join bookmakers b on b.slug = o.bookmaker_slug
left join lateral (
  select
    updated_at,
    case
      when source_url ~* '/api/' then null
      when bookmaker_slug in ('bet7k', 'betvip') and source_url ~* '/esportes/evento/' then null
      when bookmaker_slug = 'sportybet' and source_url ~* '/br/sport/football/?$' then null
      else source_url
    end as source_url
  from bookmaker_event_links
  where bookmaker_event_links.fixture_id = f.id
    and bookmaker_event_links.bookmaker_slug = o.bookmaker_slug
    and bookmaker_event_links.source_url is not null
  order by bookmaker_event_links.updated_at desc
  limit 1
) bel on true
where f.starts_at > now()
  and l.enabled = true
group by f.id;

create view public.public_odds_feed
with (security_invoker = true)
as
select
  f.fixture_id,
  f.api_football_fixture_id,
  f.fixture_name,
  f.home_team,
  f.away_team,
  f.starts_at,
  f.date_key,
  f.status,
  f.round,
  f.league_name,
  f.league_slug,
  f.league_country,
  f.league_logo_url,
  f.league_country_flag_url,
  s.odds
from public.public_odds_fixtures f
join public.public_odds_snapshot s on s.fixture_id = f.fixture_id
where f.starts_at > now();

-- Security baseline: external Supabase consumers get read-only access to safe columns only.
-- Server-side jobs keep using the Supabase secret/service role, which bypasses RLS.
grant usage on schema public to anon, authenticated;

revoke all on
  bookmakers,
  leagues,
  teams,
  fixtures,
  bookmaker_event_links,
  bookmaker_league_links,
  bookmaker_league_url_requests,
  bookmaker_payload_cache,
  odds,
  fixture_sync_runs,
  bookmaker_event_snapshots,
  bookmaker_collection_state
from anon, authenticated;
revoke all on function public.try_acquire_bookmaker_collection_lock(text, timestamptz) from anon, authenticated;

alter table bookmakers enable row level security;
alter table leagues enable row level security;
alter table teams enable row level security;
alter table fixtures enable row level security;
alter table bookmaker_event_links enable row level security;
alter table bookmaker_league_links enable row level security;
alter table bookmaker_league_url_requests enable row level security;
alter table bookmaker_payload_cache enable row level security;
alter table odds enable row level security;
alter table fixture_sync_runs enable row level security;
alter table bookmaker_event_snapshots enable row level security;
alter table bookmaker_collection_state enable row level security;

drop policy if exists public_read_bookmakers on bookmakers;
create policy public_read_bookmakers
  on bookmakers
  for select
  to anon, authenticated
  using (true);

drop policy if exists public_read_enabled_leagues on leagues;
create policy public_read_enabled_leagues
  on leagues
  for select
  to anon, authenticated
  using (enabled = true);

drop policy if exists public_read_upcoming_fixtures on fixtures;
create policy public_read_upcoming_fixtures
  on fixtures
  for select
  to anon, authenticated
  using (starts_at > now());

drop policy if exists public_read_upcoming_odds on odds;
create policy public_read_upcoming_odds
  on odds
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from fixtures
      where fixtures.id = odds.fixture_id
        and fixtures.starts_at > now()
    )
  );

drop policy if exists public_read_upcoming_bookmaker_event_links on bookmaker_event_links;
create policy public_read_upcoming_bookmaker_event_links
  on bookmaker_event_links
  for select
  to anon, authenticated
  using (
    source_url is not null
    and exists (
      select 1
      from fixtures
      join leagues on leagues.id = fixtures.league_id
      where fixtures.id = bookmaker_event_links.fixture_id
        and fixtures.starts_at > now()
        and leagues.enabled = true
    )
  );

drop policy if exists public_read_fixture_sync_status on fixture_sync_runs;
create policy public_read_fixture_sync_status
  on fixture_sync_runs
  for select
  to anon, authenticated
  using (source = 'api-football');

grant select (slug, name, updated_at) on bookmakers to anon, authenticated;
grant select (id, api_football_league_id, name, slug, country, logo_url, country_flag_url, season, enabled, updated_at) on leagues to anon, authenticated;
grant select (
  id,
  api_football_fixture_id,
  league_id,
  name,
  home_team,
  away_team,
  starts_at,
  date_key,
  status,
  round,
  updated_at
) on fixtures to anon, authenticated;
grant select (
  fixture_id,
  bookmaker_slug,
  source_url,
  updated_at
) on bookmaker_event_links to anon, authenticated;
grant select (
  fixture_id,
  bookmaker_slug,
  market_code,
  market_name,
  selection,
  price,
  pa_category,
  confidence_score,
  updated_at,
  last_seen_at
) on odds to anon, authenticated;
grant select (date_key, source, status, fixtures_seen, synced_at) on fixture_sync_runs to anon, authenticated;
grant select on public.public_odds_fixtures to anon, authenticated;
grant select on public.public_odds_snapshot to anon, authenticated;
grant select on public.public_odds_feed to anon, authenticated;
grant select on public.public_odds_feed_status to anon, authenticated;
