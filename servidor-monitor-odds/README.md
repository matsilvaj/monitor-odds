# Servidor Monitor Odds

Launcher simples para o cliente iniciar o monitor local sem digitar comandos.

## Desenvolvimento

```bash
npm install
npm run dev
```

O modo de desenvolvimento usa o `.env` e o projeto raiz.

## Gerar o executável

```bash
npm run package
```

Antes de empacotar, o script compila o projeto raiz e gera um recurso interno a partir do `.env` atual. O executável final sai em:

```text
servidor-monitor-odds/dist/Servidor Monitor Odds.exe
```

Na primeira abertura, o cliente usa o botão **Selecionar arquivo chrome.exe**. O mesmo caminho é usado para Bet365 e MeridianBet.
