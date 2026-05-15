# monitor-odds

MVP API para monitoramento simplificado de odds pre-jogo.

## Seguranca operacional

Este projeto usa dois niveis de acesso ao Supabase:

- `SUPABASE_PUBLISHABLE_KEY`: usada pelas rotas publicas da API. Essa chave respeita RLS.
- `SUPABASE_SERVICE_ROLE_KEY`: usada apenas no servidor, jobs e collectors. Nunca exponha essa chave no frontend.

Em producao, configure obrigatoriamente:

```bash
NODE_ENV=production
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
INTERNAL_COLLECT_TOKEN=... # minimo 32 caracteres
PUBLIC_API_TOKEN=... # minimo 32 caracteres
CORS_ORIGINS=https://lzcommunity.com
```

Depois de alterar `supabase/schema.sql`, aplique as politicas e grants no banco:

```bash
npm run db:setup
```

As rotas publicas devem usar somente o cliente Supabase publico. Em producao, chamadas para `/v1/*` tambem precisam enviar `Authorization: Bearer $PUBLIC_API_TOKEN` ou `x-public-api-token: $PUBLIC_API_TOKEN`.

O modo mais seguro para `lzcommunity.com` e chamar esta API a partir de um backend/proxy do proprio site, mantendo `PUBLIC_API_TOKEN` fora do navegador. Jobs, collectors e rotas `/internal/*` podem usar o cliente admin, sempre protegidos por `x-internal-token`.

## Integracao com o lz

O caminho recomendado e o `lz` ler o Supabase deste projeto pelo servidor do Next.js, sem usar a API HTTP do `monitor-odds`.

Use somente as views publicas:

- `public_odds_feed`: feed limpo de jogos futuros e odds.
- `public_odds_feed_status`: ultima atualizacao e contadores do feed.

Nao use tabelas internas no `lz`, especialmente `collection_logs`, `bookmaker_event_snapshots`, `bookmaker_payload_cache`, `bookmaker_collection_state`, `bookmaker_event_links` e `bookmaker_league_links`.

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
