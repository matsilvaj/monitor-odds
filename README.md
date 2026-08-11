# monitor-odds

Coletor automatizado de odds pré-jogo de casas de apostas brasileiras. Scrapa ~30 bookmakers continuamente e persiste as cotações em um banco Supabase/PostgreSQL, usando API-Football como fonte canônica de fixtures.

## Funcionalidades

- Coleta de odds de ~30 casas de apostas brasileiras em loop contínuo
- Vínculo automático entre eventos dos bookmakers e fixtures canônicos (via fuzzy matching + fallback LLM com Gemini)
- Aprendizado de aliases de times: resultados de matching salvos no banco para evitar chamadas repetidas ao LLM
- Dashboard ao vivo no terminal com contagem de cobertura por casa
- Suporte a coleta via HTTP e via browser (Playwright) para sites com proteção anti-bot
- Arquitetura supervisor + workers com watchdog: reinicialização automática em caso de crash ou timeout

## Stack

- **Runtime:** Node.js ≥24 (ESM)
- **Linguagem:** TypeScript 6 (`tsx` para dev, `tsc` para build)
- **Banco:** Supabase (PostgreSQL) — cliente JS + conexão direta via `pg`
- **HTTP scraping:** `got-scraping` (fingerprinting anti-bot) e `fetch` nativo
- **Browser:** Playwright Core (Bet365, MeridianBet)
- **LLM matching:** Google Gemini (`gemini-2.5-flash-lite`) via `@google/genai`
- **Concorrência:** `p-map`
- **Validação:** Zod (env vars com falha rápida na inicialização)

## Pré-requisitos

- Node.js 24+
- Projeto no [Supabase](https://supabase.com) com schema aplicado
- Chave de API em [api-football.com](https://www.api-football.com)
- (Opcional) Chave de API do Google Gemini para fallback de matching de times

## Instalação

```bash
npm install
```

Copie o arquivo de exemplo de variáveis de ambiente:

```bash
cp .env.example .env
```

Edite `.env` com suas credenciais (veja seção [Configuração](#configuração)).

Aplique o schema do banco no seu projeto Supabase (via SQL Editor ou `psql`):

```bash
# Cole o conteúdo de supabase/schema.sql no SQL Editor do Supabase
```

Popule a tabela de casas de apostas:

```bash
npm run db:setup
```

## Uso

### Daemon principal (loop contínuo)

```bash
npm run dev      # desenvolvimento (sem build)
npm start        # produção (requer npm run build antes)
```

O daemon inicia três workers paralelos:

| Lane | Descrição |
|---|---|
| `fast` | Todos os coletores HTTP, concorrência 3, ciclo ≤25 min |
| `meridianbet` | Browser Playwright dedicado, ciclo ≤45 min |
| `bet365` | Browser Playwright dedicado, ciclo ≤45 min (requer `BET365_ENABLED=true`) |

### Comandos avulsos

```bash
npm run sync:all       # Sincroniza fixtures + coleta odds uma vez
npm run sync:fixtures  # Sincroniza só fixtures da API-Football
npm run sync:odds      # Coleta odds de todos os bookmakers uma vez
npm run collect        # Coleta um bookmaker específico (ex: npm run collect -- sportingbet)
npm run status         # Relatório de cobertura por bookmaker no terminal
npm run build          # Compila TypeScript
npm run typecheck      # Verifica tipos sem emitir
npm run test:matching  # Testes do pipeline de matching
```

## Configuração

Todas as opções são via variáveis de ambiente, validadas pelo Zod na inicialização.

### Obrigatórias

| Variável | Descrição |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase (`https://...`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key do Supabase |
| `API_FOOTBALL_KEY` | Chave da API-Football |

### Recomendadas

| Variável | Descrição |
|---|---|
| `GEMINI_API_KEY` | Chave do Google Gemini para fallback de matching de times |
| `SUPABASE_DB_URL` | String de conexão direta ao Postgres |

### Coletor Bet365 (Playwright)

| Variável | Padrão | Descrição |
|---|---|---|
| `BET365_ENABLED` | `false` | Habilita o worker Bet365 |
| `BET365_CHROME_PROFILE_DIR` | `.browser/bet365-profile` | Diretório do perfil Chrome |
| `BET365_CHROME_EXECUTABLE` | — | Caminho do binário Chrome |
| `BET365_MONITOR_TABS` | `5` | Abas paralelas (máx 5) |
| `BET365_TARGET_LEAGUE_SLUGS` | — | Liga(s) específicas (separadas por vírgula) |
| `BET365_FIXTURE_LIMIT_PER_LEAGUE` | `25` | Máximo de fixtures por liga |

### Coletor MeridianBet (Playwright)

| Variável | Padrão | Descrição |
|---|---|---|
| `MERIDIANBET_CHROME_PROFILE_DIR` | `.browser/meridianbet-cdp-profile` | Diretório do perfil Chrome |
| `MERIDIANBET_CHROME_EXECUTABLE` | — | Caminho do binário Chrome |
| `MERIDIANBET_MONITOR_TABS` | `5` | Abas paralelas (máx 8) |

### Watchdog / tuning

| Variável | Padrão | Descrição |
|---|---|---|
| `COLLECT_DELAY_MS` | `1500` | Delay entre requests HTTP dos coletores |
| `WATCHDOG_FAST_CYCLE_TIMEOUT_MS` | `1500000` (25 min) | Timeout de ciclo da lane fast |
| `WATCHDOG_MERIDIAN_CYCLE_TIMEOUT_MS` | `2700000` (45 min) | Timeout da lane MeridianBet |
| `WATCHDOG_BET365_CYCLE_TIMEOUT_MS` | `2700000` (45 min) | Timeout da lane Bet365 |
| `WATCHDOG_MAX_RESTARTS_PER_WINDOW` | `5` | Máximo de restarts antes de pausar a lane |

## Arquitetura

```
sync-watch (supervisor)
├── Worker: fast lane          → HTTP collectors (p-map, concorrência 3)
├── Worker: meridianbet lane   → Playwright browser
└── Worker: bet365 lane        → Playwright browser
```

O supervisor comunica com os workers via IPC e executa um watchdog a cada 15s. Workers sem heartbeat por >90s ou que ultrapassem o timeout de ciclo são reiniciados com backoff exponencial.

### Pipeline de matching de times

Quando um bookmaker retorna um evento, o nome dos times pode diferir do cadastro canônico. O pipeline tenta, em ordem:

1. **Alias no banco** — consulta `apelidos_times` por um par já conhecido
2. **Fuzzy matching** — Jaro-Winkler + similaridade token-set
3. **Fallback LLM** — chama Gemini com até 30 candidatos; resultado é salvo como alias para uso futuro

## Banco de dados

Schema principal em [`supabase/schema.sql`](supabase/schema.sql):

| Tabela | Conteúdo |
|---|---|
| `casas_apostas` | Registry de bookmakers |
| `campeonatos` | Ligas/competições (API-Football) |
| `times` | Times (API-Football) |
| `apelidos_times` | Aliases de nomes de times aprendidos |
| `jogos` | Fixtures canônicos |
| `links_eventos` | Vínculo bookmaker ↔ fixture com score de confiança |
| `cotacoes` | Odds: uma linha por (fixture, casa, mercado, seleção, categoria PA) |
| `links_campeonatos` | Vínculo página de liga do bookmaker ↔ liga API-Football |

## Ligas monitoradas

~60 competições, incluindo: Brasileirão A e B, Copa do Brasil, Libertadores, Sul-Americana, Champions League, Europa League, Conference League, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, MLS e principais copas nacionais europeias e sul-americanas.
