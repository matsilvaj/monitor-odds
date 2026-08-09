create extension if not exists pgcrypto;

create table if not exists casas_apostas (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campeonatos (
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

alter table campeonatos add column if not exists logo_url text;
alter table campeonatos add column if not exists country_flag_url text;
alter table campeonatos add column if not exists deleted_at timestamptz;

create table if not exists times (
  id uuid primary key default gen_random_uuid(),
  api_football_team_id bigint not null unique,
  name text not null,
  normalized_name text not null,
  logo_url text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists apelidos_times (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references times(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  source text not null default 'generated',
  confidence numeric not null default 0.8,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, normalized_alias)
);

create index if not exists team_aliases_normalized_alias_idx
  on apelidos_times (normalized_alias);

create table if not exists jogos (
  id uuid primary key default gen_random_uuid(),
  api_football_fixture_id bigint not null unique,
  league_id uuid not null references campeonatos(id) on delete cascade,
  home_team_id uuid not null references times(id) on delete restrict,
  away_team_id uuid not null references times(id) on delete restrict,
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

create table if not exists links_eventos (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references jogos(id) on delete cascade,
  bookmaker_slug text not null references casas_apostas(slug) on delete cascade,
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

create table if not exists links_campeonatos (
  id uuid primary key default gen_random_uuid(),
  bookmaker_slug text not null references casas_apostas(slug) on delete cascade,
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


create table if not exists cotacoes (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references jogos(id) on delete cascade,
  bookmaker_slug text not null references casas_apostas(slug) on delete cascade,
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

alter table cotacoes add column if not exists last_seen_at timestamptz not null default now();
update cotacoes
set last_seen_at = coalesce(last_seen_at, updated_at, now());

create or replace function set_database_updated_at()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and TG_TABLE_NAME = 'cotacoes'
     and (to_jsonb(new) - 'updated_at' - 'last_seen_at') = (to_jsonb(old) - 'updated_at' - 'last_seen_at') then
    new.updated_at = old.updated_at;
    return new;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists odds_set_database_updated_at on cotacoes;
create trigger odds_set_database_updated_at
before insert or update on cotacoes
for each row
execute function set_database_updated_at();

drop trigger if exists bookmaker_event_links_set_database_updated_at on links_eventos;
create trigger bookmaker_event_links_set_database_updated_at
before insert or update on links_eventos
for each row
execute function set_database_updated_at();

drop trigger if exists team_aliases_set_database_updated_at on apelidos_times;
create trigger team_aliases_set_database_updated_at
before insert or update on apelidos_times
for each row
execute function set_database_updated_at();

update cotacoes
set updated_at = now()
where updated_at > now();

update links_eventos
set updated_at = now()
where updated_at > now();

create table if not exists execucoes_sync_jogos (
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

alter table execucoes_sync_jogos add column if not exists league_ids_hash text;

create table if not exists capturas_eventos (
  id uuid primary key default gen_random_uuid(),
  bookmaker_slug text not null references casas_apostas(slug) on delete cascade,
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

create table if not exists estado_coletas (
  bookmaker_slug text primary key references casas_apostas(slug) on delete cascade,
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
  insert into estado_coletas (bookmaker_slug, status, lease_until, last_started_at, updated_at)
  values (p_bookmaker_slug, 'running', p_lease_until, now(), now())
  on conflict (bookmaker_slug) do update
    set status = 'running',
        lease_until = p_lease_until,
        last_started_at = now(),
        updated_at = now()
    where estado_coletas.lease_until is null
       or estado_coletas.lease_until < now()
       or estado_coletas.status <> 'running'
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create index if not exists fixtures_search_idx on jogos using gin (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(home_team, '') || ' ' || coalesce(away_team, ''))
);

create index if not exists fixtures_starts_at_idx on jogos (starts_at);
create index if not exists fixtures_date_key_idx on jogos (date_key);
create index if not exists fixtures_league_id_idx on jogos (league_id);
create index if not exists teams_normalized_name_idx on times (normalized_name);
create index if not exists odds_fixture_id_idx on cotacoes (fixture_id);
create index if not exists odds_bookmaker_market_fixture_idx on cotacoes (bookmaker_slug, market_code, fixture_id);
create index if not exists bookmaker_event_links_fixture_id_idx on links_eventos (fixture_id);
create index if not exists bookmaker_event_links_bookmaker_fixture_idx on links_eventos (bookmaker_slug, fixture_id);
create index if not exists bookmaker_league_links_slug_league_idx on links_campeonatos (bookmaker_slug, api_football_league_id);
create index if not exists bookmaker_event_snapshots_bookmaker_date_idx on capturas_eventos (bookmaker_slug, date_key);
create index if not exists bookmaker_event_snapshots_league_idx on capturas_eventos (league_api_football_id);
create index if not exists bookmaker_collection_state_next_run_idx on estado_coletas (next_run_at);

drop view if exists public.public_feed_cotacoes;
drop view if exists public.public_snapshot_cotacoes;
drop view if exists public.public_jogos_com_cotacoes;
drop view if exists public.public_odds_feed_compact;
drop view if exists public.public_status_feed_cotacoes;

create view public.public_status_feed_cotacoes
with (security_invoker = true)
as
with upcoming_fixtures as (
  select
    f.id,
    greatest(f.updated_at, l.updated_at) as fixture_version
  from jogos f
  join campeonatos l on l.id = f.league_id
  where f.starts_at > now()
    and l.enabled = true
    and exists (
      select 1
      from cotacoes o
      where o.fixture_id = f.id
        and o.market_code = '1X2'
    )
),
upcoming_odds as (
  select
    o.fixture_id,
    greatest(o.updated_at, o.last_seen_at) as odds_version
  from cotacoes o
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

create view public.public_jogos_com_cotacoes
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
from jogos f
join campeonatos l on l.id = f.league_id
where f.starts_at > now()
  and l.enabled = true
  and exists (
    select 1
    from cotacoes o
    where o.fixture_id = f.id
      and o.market_code = '1X2'
  );

create view public.public_snapshot_cotacoes
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
          when 'exchange' then 'https://tradeball.fulltbet.bet.br/'
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
  ) as cotacoes
from jogos f
join campeonatos l on l.id = f.league_id
join cotacoes o on o.fixture_id = f.id
join casas_apostas b on b.slug = o.bookmaker_slug
left join lateral (
  select
    updated_at,
    case
      when source_url ~* '/api/' then null
      when bookmaker_slug in ('bet7k', 'betvip') and source_url ~* '/esportes/evento/' then null
      when bookmaker_slug = 'sportybet' and source_url ~* '/br/sport/football/?$' then null
      else source_url
    end as source_url
  from links_eventos
  where links_eventos.fixture_id = f.id
    and links_eventos.bookmaker_slug = o.bookmaker_slug
    and links_eventos.source_url is not null
  order by links_eventos.updated_at desc
  limit 1
) bel on true
where f.starts_at > now()
  and l.enabled = true
group by f.id;

create view public.public_feed_cotacoes
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
  s.cotacoes
from public.public_jogos_com_cotacoes f
join public.public_snapshot_cotacoes s on s.fixture_id = f.fixture_id
where f.starts_at > now();

-- Security baseline: external Supabase consumers get read-only access to safe columns only.
-- Server-side jobs keep using the Supabase secret/service role, which bypasses RLS.
grant usage on schema public to anon, authenticated;

revoke all on
  casas_apostas,
  campeonatos,
  times,
  apelidos_times,
  jogos,
  links_eventos,
  links_campeonatos,
  cotacoes,
  execucoes_sync_jogos,
  capturas_eventos,
  estado_coletas
from anon, authenticated;
revoke all on function public.try_acquire_bookmaker_collection_lock(text, timestamptz) from anon, authenticated;

alter table casas_apostas enable row level security;
alter table campeonatos enable row level security;
alter table times enable row level security;
alter table apelidos_times enable row level security;
alter table jogos enable row level security;
alter table links_eventos enable row level security;
alter table links_campeonatos enable row level security;
alter table cotacoes enable row level security;
alter table execucoes_sync_jogos enable row level security;
alter table capturas_eventos enable row level security;
alter table estado_coletas enable row level security;

drop policy if exists public_read_bookmakers on casas_apostas;
create policy public_read_bookmakers
  on casas_apostas
  for select
  to anon, authenticated
  using (true);

drop policy if exists public_read_enabled_leagues on campeonatos;
create policy public_read_enabled_leagues
  on campeonatos
  for select
  to anon, authenticated
  using (enabled = true);

drop policy if exists public_read_upcoming_fixtures on jogos;
create policy public_read_upcoming_fixtures
  on jogos
  for select
  to anon, authenticated
  using (starts_at > now());

drop policy if exists public_read_upcoming_odds on cotacoes;
create policy public_read_upcoming_odds
  on cotacoes
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from jogos
      where jogos.id = cotacoes.fixture_id
        and jogos.starts_at > now()
    )
  );

drop policy if exists public_read_upcoming_bookmaker_event_links on links_eventos;
create policy public_read_upcoming_bookmaker_event_links
  on links_eventos
  for select
  to anon, authenticated
  using (
    source_url is not null
    and exists (
      select 1
      from jogos
      join campeonatos on campeonatos.id = jogos.league_id
      where jogos.id = links_eventos.fixture_id
        and jogos.starts_at > now()
        and campeonatos.enabled = true
    )
  );

drop policy if exists public_read_fixture_sync_status on execucoes_sync_jogos;
create policy public_read_fixture_sync_status
  on execucoes_sync_jogos
  for select
  to anon, authenticated
  using (source = 'api-football');

grant select (slug, name, updated_at) on casas_apostas to anon, authenticated;
grant select (id, api_football_league_id, name, slug, country, logo_url, country_flag_url, season, enabled, updated_at) on campeonatos to anon, authenticated;
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
) on jogos to anon, authenticated;
grant select (
  fixture_id,
  bookmaker_slug,
  source_url,
  updated_at
) on links_eventos to anon, authenticated;
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
) on cotacoes to anon, authenticated;
grant select (date_key, source, status, fixtures_seen, synced_at) on execucoes_sync_jogos to anon, authenticated;
grant select on public.public_jogos_com_cotacoes to anon, authenticated;
grant select on public.public_snapshot_cotacoes to anon, authenticated;
grant select on public.public_feed_cotacoes to anon, authenticated;
grant select on public.public_status_feed_cotacoes to anon, authenticated;
