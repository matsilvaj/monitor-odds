# Plano de Organizacao do Banco

Objetivo: simplificar o banco sem quebrar os coletores. O sistema deve continuar simples:
a API traz os jogos, o coletor entra nas casas, coleta odds, salva cache do evento, e o matching confirma ou reutiliza vinculos ja conhecidos.

Este documento registra o diagnostico e as etapas aplicadas de organizacao do banco.

## Regras

- Nao remover tabela em producao sem backup.
- Nao renomear tabela antes de atualizar o codigo que usa `supabase.from(...)`.
- Separar claramente dado principal, cache, snapshot temporario, fila operacional e historico.
- Evitar `raw` com historico empilhado dentro de historico.
- Preferir nomes em portugues no modelo final.

## Modelo Final Aplicado Para Tabelas/Views

| Nome atual | Nome em portugues sugerido | Funcao | Acao sugerida |
|---|---|---|---|
| `bookmakers` | `casas_apostas` | Cadastro das casas | Renomeada |
| `leagues` | `campeonatos` | Campeonatos vindos da API | Renomeada |
| `teams` | `times` | Times vindos da API | Renomeada |
| `team_aliases` | `apelidos_times` | Memoria de nomes confirmados por casa | Renomeada; manter e organizar |
| `fixtures` | `jogos` | Jogos D0/D1 vindos da API | Renomeada |
| `odds` | `cotacoes` | Odds finais publicadas | Renomeada |
| `bookmaker_event_links` | `links_eventos` | Cache confirmado de evento por casa | Renomeada; e tabela central do cache |
| `bookmaker_event_snapshots` | `capturas_eventos` | Capturas brutas para matching offline | Renomeada; manter enquanto Bet365/Meridian usam matching externo |
| `bookmaker_league_links` | `links_campeonatos` | Links das ligas/campeonatos nas casas | Renomeada |
| `bookmaker_league_url_requests` | `pendencias_links_campeonatos` | Fila operacional quando link falta/falha | Renomeada; manter ou substituir por painel/log |
| `bookmaker_collection_state` | `estado_coletas` | Estado da ultima coleta por casa | Renomeada |
| `fixture_sync_runs` | `execucoes_sync_jogos` | Historico do sync da API-Football | Renomeada; manter com retencao |
| `bookmaker_payload_cache` | - | Cache antigo de payload | Remover apos backup; esta vazio e sem uso no codigo |
| `bookmaker_discovery_state` | - | Estado antigo de discovery | Arquivar/remover apos validar que nao ha uso |
| `team_resolution_attempts` | - | Tentativas antigas de resolucao online/IA | Arquivar/remover apos backup |
| `team_resolution_daily_usage` | - | Contador da resolucao online/IA antiga | Arquivar/remover junto com `team_resolution_attempts` |
| `public_odds_feed` | `public_feed_cotacoes` | View publica agregada | Renomeada |
| `public_odds_fixtures` | `public_jogos_com_cotacoes` | View publica de jogos com odds | Renomeada |
| `public_odds_snapshot` | `public_snapshot_cotacoes` | View publica das odds por jogo | Renomeada |
| `public_odds_feed_status` | `public_status_feed_cotacoes` | View publica de status | Renomeada |

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
6. Renomear fisicamente tabelas/views para portugues apos codigo ajustado e testes passando.

## Decisao Sobre Renomear Para Portugues

A renomeacao fisica das tabelas e views ativas foi aplicada em 2026-08-06, apos atualizar o codigo e validar typecheck/testes.

Escopo aplicado nesta etapa:

- Tabelas e views do schema `public` foram renomeadas para portugues.
- As colunas permaneceram com os nomes atuais em ingles para reduzir risco e evitar uma migracao grande demais no mesmo passo.
- Indices, triggers, constraints e policies podem continuar com nomes antigos internamente; isso nao afeta funcionamento e pode ser padronizado em uma etapa cosmetica futura.
- Tabelas arquivadas no schema `archive` mantiveram os nomes historicos para preservar auditoria.

Validacoes executadas apos a renomeacao:

- Inventario do Supabase confirmou 16 objetos novos no `public` e 0 objetos antigos restantes.
- Consultas pelo cliente Supabase do projeto passaram em `jogos`, `cotacoes`, `links_eventos` e `links_campeonatos`.
- `npm run typecheck` passou.
- `npm run test:matching` passou.

## Etapa Aplicada em 2026-08-06

Foi aplicada a primeira limpeza segura no Supabase:

- `bookmaker_payload_cache` foi removida porque estava vazia e sem uso no codigo.
- `bookmaker_discovery_state` foi movida para `archive.bookmaker_discovery_state`, preservando 6 registros.
- `team_resolution_attempts` foi movida para `archive.team_resolution_attempts`, preservando 4218 registros.
- `team_resolution_daily_usage` foi movida para `archive.team_resolution_daily_usage`, preservando 15 registros.

Tabelas/views ativas restantes no schema `public` depois dessa etapa:

- `apelidos_times`
- `campeonatos`
- `capturas_eventos`
- `casas_apostas`
- `cotacoes`
- `estado_coletas`
- `execucoes_sync_jogos`
- `jogos`
- `links_campeonatos`
- `links_eventos`
- `pendencias_links_campeonatos`
- `public_feed_cotacoes`
- `public_jogos_com_cotacoes`
- `public_snapshot_cotacoes`
- `public_status_feed_cotacoes`
- `times`

## Etapa Aplicada em 2026-08-06: Renomeacao Para Portugues

Foi aplicada a renomeacao fisica das tabelas/views ativas do schema `public` conforme a nomenclatura acima.

Contagens verificadas apos a migracao:

- `casas_apostas`: 30
- `campeonatos`: 51
- `times`: 829
- `apelidos_times`: 768
- `jogos`: 12
- `cotacoes`: 1243
- `links_eventos`: 323
- `capturas_eventos`: 31
- `links_campeonatos`: 66
- `pendencias_links_campeonatos`: 9
- `estado_coletas`: 2
- `execucoes_sync_jogos`: 174
