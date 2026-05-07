# Monitor Odds MVP

MVP simplificado para sincronizar jogos pela API-Football, coletar odds pre-jogo da EsportivaBet/Altenar e servir uma API de pesquisa para um frontend Next.js.

Use este conector somente quando a coleta for permitida para o seu caso de uso. O projeto nao inclui logica para contornar bloqueios, captchas, autenticacao ou mecanismos anti-abuso.

## Setup

1. Preencha o `.env` com `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_FOOTBALL_KEY` e, se quiser setup automatico, `SUPABASE_DB_URL`.
2. Crie as tabelas no Supabase usando uma das opcoes:

```bash
npm run db:setup
```

Ou copie `supabase/schema.sql` e execute no SQL Editor do Supabase.

3. Rode:

```bash
npm run sync:fixtures
npm run sync:odds
npm run collect:esportiva
npm run dev
```

Ou rode tudo em sequencia:

```bash
npm run sync:all
```

Para deixar rodando localmente com intervalo dinamico:

```bash
npm run sync:watch
```

Para rodar API e watcher em um terminal:

```bash
npm run dev:all
```

Intervalos do `sync:watch`:

- jogo a mais de 24h: odds a cada 1h;
- jogo em menos de 24h: odds a cada 30m;
- jogo em menos de 6h: odds a cada 15m;
- jogo em menos de 3h: odds a cada 1m.

Se voce adicionar/remover ligas e quiser ignorar o cache:

```powershell
$env:FORCE_SYNC='true'; npm run sync:all; Remove-Item Env:FORCE_SYNC
```

## Endpoints

```text
GET  /health
GET  /v1/status
GET  /v1/fixtures?search=flamengo
GET  /v1/odds/search?q=flamengo
GET  /v1/fixtures/:id/odds
POST /internal/sync/fixtures
POST /internal/collect/esportiva
POST /internal/sync/all
```

## Ligas do MVP

- Europa League: Altenar `16809`
- Libertadores: Altenar `3709`
- Brasileirao: Altenar `11318`
- Bundesliga: Altenar `2950`
- La Liga: Altenar `2941`
- Premier League: Altenar `2936`

## Fonte canonica

A API-Football e a fonte canonica de jogos, ligas e times. No plano free atual, o MVP busca apenas D0 e D1. A Esportiva nao cria fixtures; ela apenas cria um vinculo em `bookmaker_event_links` quando o evento da casa bate com um fixture canonico por liga, horario e similaridade de nomes. Isso deixa o MVP pronto para adicionar novas casas sem refazer a base de jogos.

## Mais casas

Os coletores ficam registrados em `src/bookmakers/registry.ts`. Para adicionar uma nova casa:

1. criar um provider/coletor da casa;
2. registrar no `BOOKMAKER_COLLECTORS`;
3. garantir que o coletor salve `bookmaker_event_links` e `odds` usando o `fixture_id` canonico.

## GitHub

O `.env` fica fora do Git por seguranca. Use `.env.example` como modelo.
