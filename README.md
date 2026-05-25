# monitor-odds

Coletor de odds pre-jogo com persistencia no Supabase.

Este projeto nao expoe API HTTP. Ele sincroniza fixtures via API-Football, coleta odds nas casas configuradas, normaliza os dados e salva tudo no banco. Outros projetos, como o `lz`, devem consumir os dados lendo as views publicas do Supabase.

## Requisitos

Veja [REQUIREMENTS.md](./REQUIREMENTS.md) para preparar Node, npm, Supabase, API-Football, Chrome e `.env` em um PC novo.

## Seguranca operacional

Este projeto usa acesso de servidor ao Supabase:

- `SUPABASE_SERVICE_ROLE_KEY`: usada apenas pelos jobs e collectors. Nunca exponha essa chave no frontend.
- `SUPABASE_DB_URL`: usada pelo comando `npm run db:setup` para aplicar `supabase/schema.sql`.

Em producao, configure:

```bash
NODE_ENV=production
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_URL=...
API_FOOTBALL_KEY=...
```

Depois de alterar `supabase/schema.sql`, aplique o schema, views, policies e grants no banco:

```bash
npm run db:setup
```

## Execucao

Para rodar o ciclo continuo de coleta:

```bash
npm run dev
```

Comandos uteis:

```bash
npm run sync:watch
npm run sync
npm run sync:fixtures
npm run sync:odds
npm run collect:bookmaker bet365
npm run client:package
```

Para gerar uma versao com auto-update publicada no GitHub Releases, use:

```bash
npm run client:release
```

O comando le `GH_TOKEN` do `.env` local para publicar a release, mas esse token nao e incluido no instalador.

## Integracao com o lz

O `lz` deve ler o Supabase deste projeto pelo servidor do Next.js, sem chamar uma API HTTP do `monitor-odds`.

Use somente as views publicas:

- `public_odds_feed`: feed limpo de jogos futuros e odds.
- `public_odds_feed_compact`: feed agrupado por jogo, com as odds dentro do array `odds`; prefira esta view para reduzir egress.
- `public_odds_feed_status`: ultima atualizacao e contadores do feed.

O feed publico tambem expoe metadados visuais da liga:

- `league_logo_url`: logo da competicao vindo da API-Football.
- `league_country_flag_url`: bandeira/pais da competicao vindo da API-Football, quando disponivel.
- `bookmaker_event_url`: link do evento na casa referente aquela odd.

Nao use tabelas internas no `lz`, especialmente `bookmaker_event_snapshots`, `bookmaker_payload_cache`, `bookmaker_collection_state`, `bookmaker_event_links` e `bookmaker_league_links`.

As envs esperadas no `lz` devem ser server-only:

```bash
MONITOR_SUPABASE_URL=...
MONITOR_SUPABASE_PUBLISHABLE_KEY=...
```

O `lz` deve usar `public_odds_feed_status.latest_odd_updated_at` para detectar se houve atualizacao e recarregar a tela/cache.

Antes de publicar:

```bash
npm run typecheck
npm audit
```
