# Plano de Organizacao do Banco

Objetivo: simplificar o banco sem quebrar os coletores. O sistema deve continuar simples:
a API traz os jogos, o coletor entra nas casas, coleta odds, salva cache do evento, e o matching confirma ou reutiliza vinculos ja conhecidos.

Este documento e um diagnostico/plano. Nao representa migration aplicada.

## Regras

- Nao remover tabela em producao sem backup.
- Nao renomear tabela antes de atualizar o codigo que usa `supabase.from(...)`.
- Separar claramente dado principal, cache, snapshot temporario, fila operacional e historico.
- Evitar `raw` com historico empilhado dentro de historico.
- Preferir nomes em portugues no modelo final.

## Modelo Final Sugerido

| Nome atual | Nome em portugues sugerido | Funcao | Acao sugerida |
|---|---|---|---|
| `bookmakers` | `casas_apostas` | Cadastro das casas | Manter, renomear em migration coordenada |
| `leagues` | `campeonatos` | Campeonatos vindos da API | Manter, renomear em migration coordenada |
| `teams` | `times` | Times vindos da API | Manter, renomear em migration coordenada |
| `team_aliases` | `apelidos_times` | Memoria de nomes confirmados por casa | Manter e organizar |
| `fixtures` | `jogos` | Jogos D0/D1 vindos da API | Manter, renomear em migration coordenada |
| `odds` | `cotacoes` | Odds finais publicadas | Manter, renomear em migration coordenada |
| `bookmaker_event_links` | `links_eventos` | Cache confirmado de evento por casa | Manter; e tabela central do cache |
| `bookmaker_event_snapshots` | `capturas_eventos` | Capturas brutas para matching offline | Manter enquanto Bet365/Meridian usam matching externo |
| `bookmaker_league_links` | `links_campeonatos` | Links das ligas/campeonatos nas casas | Manter |
| `bookmaker_league_url_requests` | `pendencias_links_campeonatos` | Fila operacional quando link falta/falha | Manter ou substituir por painel/log |
| `bookmaker_collection_state` | `estado_coletas` | Estado da ultima coleta por casa | Manter |
| `fixture_sync_runs` | `execucoes_sync_jogos` | Historico do sync da API-Football | Manter, com retencao |
| `bookmaker_payload_cache` | - | Cache antigo de payload | Remover apos backup; esta vazio e sem uso no codigo |
| `bookmaker_discovery_state` | - | Estado antigo de discovery | Arquivar/remover apos validar que nao ha uso |
| `team_resolution_attempts` | - | Tentativas antigas de resolucao online/IA | Arquivar/remover apos backup |
| `team_resolution_daily_usage` | - | Contador da resolucao online/IA antiga | Arquivar/remover junto com `team_resolution_attempts` |
| `public_odds_feed` | `public_feed_cotacoes` | View publica agregada | Renomear por ultimo |
| `public_odds_fixtures` | `public_jogos_com_cotacoes` | View publica de jogos com odds | Renomear por ultimo |
| `public_odds_snapshot` | `public_snapshot_cotacoes` | View publica das odds por jogo | Renomear por ultimo |
| `public_odds_feed_status` | `public_status_feed_cotacoes` | View publica de status | Renomear por ultimo |

## Separacao Correta de Responsabilidades

### Dado principal

- `campeonatos`
- `times`
- `jogos`
- `casas_apostas`
- `cotacoes`

Essas tabelas sao o nucleo do sistema. Nao devem conter estado temporario de coleta.

### Cache confirmado

- `links_eventos`
- `links_campeonatos`
- `apelidos_times`

Essas tabelas representam conhecimento confirmado. O coletor deve reutilizar esses dados para evitar gargalo.

### Temporario / matching

- `capturas_eventos`

Essa tabela deve guardar apenas a captura atual/recente que ainda precisa ser consolidada no matching.
Depois que o evento foi confirmado, o vinculo permanente fica em `links_eventos`.

### Operacional

- `estado_coletas`
- `pendencias_links_campeonatos`
- `execucoes_sync_jogos`

Essas tabelas ajudam a operar o sistema, mas nao sao a fonte principal das odds.

## Problemas Atuais

### `bookmaker_event_links.raw` esta pesado

Hoje o `raw` pode guardar `snapshotRaw` dentro de `snapshotRaw`, acumulando historico desnecessario.
O ideal e manter apenas campos vivos:

```json
{
  "orientation": "NORMAL",
  "associationConfirmed": true,
  "collectionUrl": "...",
  "rawSourceUrl": "...",
  "lastDirectOkAt": "...",
  "lastDirectFailAt": "...",
  "lastFailReason": null,
  "failCount": 0,
  "marketsSeen": ["COM_PA", "SEM_PA"]
}
```

### `bookmaker_event_snapshots` nao deve virar cache permanente

Snapshots sao bons para matching offline, mas o cache real deve ser `bookmaker_event_links`.
Se uma casa ja confirmou o evento, a proxima coleta deve ir pelo link cacheado.

### Tabelas antigas de resolucao

`team_resolution_attempts` e `team_resolution_daily_usage` parecem vir de um sistema antigo de matching online/IA.
Como o matching atual usa aliases e snapshots, essas tabelas devem ser arquivadas antes de remover.

## Ordem Segura de Execucao

1. Criar backup/export das tabelas candidatas a remocao.
2. Limpar `raw` empilhado de `bookmaker_event_links` e `bookmaker_event_snapshots`.
3. Adicionar documentacao/comentarios no schema sobre a funcao de cada tabela.
4. Remover tabelas sem uso:
   - `bookmaker_payload_cache`
   - `bookmaker_discovery_state`
5. Arquivar e depois remover tabelas antigas de IA/resolucao:
   - `team_resolution_attempts`
   - `team_resolution_daily_usage`
6. So depois disso, planejar renomeacao fisica das tabelas para portugues.

## Decisao Sobre Renomear Para Portugues

Renomear fisicamente as tabelas deixa o banco mais legivel, mas exige alterar todo o codigo.
Para evitar quebra, a recomendacao e fazer em uma etapa separada:

1. Atualizar `supabase/schema.sql`.
2. Atualizar todos os `supabase.from(...)`.
3. Atualizar views, policies, grants, triggers e indices.
4. Rodar `npm run typecheck`.
5. Rodar coleta Bet365/Meridian em escopo pequeno.
6. Rodar coleta completa.

Enquanto isso, este documento define a nomenclatura oficial em portugues.
