# Requirements

Checklist para preparar este projeto em um PC novo sem adivinhacao.

## Runtime

- Node.js 24.x
- npm 11.x
- Git
- Google Chrome instalado, necessario para o collector da bet365

Este repositorio foi validado com:

```bash
node -v # v24.14.1
npm -v  # 11.11.0
```

Use `.nvmrc` ou `.node-version` para selecionar a mesma versao do Node quando o gerenciador da maquina suportar esses arquivos.

## Contas e acessos

- Projeto Supabase com URL, service role key e senha/URL do banco.
- Chave da API-Football / API-SPORTS.
- Permissao para aplicar `supabase/schema.sql` no banco.

## Setup em maquina nova

1. Instale Node.js 24.x e npm 11.x.
2. Instale as dependencias:

```bash
npm ci
```

3. Crie o arquivo `.env` a partir de `.env.example` e preencha os valores sensiveis.

4. Aplique o schema/policies/views no Supabase:

```bash
npm run db:setup
```

5. Valide o projeto:

```bash
npm run typecheck
npm run build
```

6. Rode o coletor local:

```bash
npm run dev
```

## Variaveis obrigatorias

O `.env.example` deve espelhar o `.env` real, mas sem segredos preenchidos.

- `NODE_ENV`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`
- `API_FOOTBALL_KEY`

Para aplicar o schema, `SUPABASE_DB_PASSWORD` tambem pode ser usado quando a URL do banco vier com placeholder de senha.

## Overrides opcionais

O codigo ja tem defaults para API-Football base URL/timezone/TTL, Altenar, retencao de logs e bet365. So adicione essas variaveis ao `.env` quando precisar sobrescrever algo localmente.

Para a bet365, o projeto tenta encontrar o Chrome instalado automaticamente. Se o Chrome estiver em um caminho fora do padrao, use `BET365_CHROME_EXECUTABLE` temporariamente no `.env` local.

## Comandos uteis

```bash
npm run dev
npm run sync:watch
npm run sync:fixtures
npm run sync:odds
npm run sync
npm run collect:bookmaker bet365
npm run fechar:coleta bet365
```
