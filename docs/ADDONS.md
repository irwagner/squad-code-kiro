# Add-ons do SQUAD/CODE

Guia do que foi adicionado ao orquestrador (sobre o kiro-cli headless) e como usar — mais os próximos passos que dependem de pré-requisitos externos. Catálogo conceitual completo: `../ADDONS_SQUAD_CODE.md`.

## Já implementado e verificado

### Recursos nativos do kiro-cli (aba Configurações → Kiro CLI)
- **Engine do agente** (`--agent-engine`): v2 (padrão), v3 (próxima geração) ou v1.
- **Modo (só V3)** (`--mode`): `spec` ativa o fluxo spec-driven (requisitos/design antes de codar). Só é enviado quando o engine é v3.
- **Executar na nuvem** (`--cloud` + `--repo owner/name`): roda a etapa num sandbox gerenciado do Kiro (V3). Pré-requisito: login no Kiro e o repositório acessível; teto ~10 sessões simultâneas por conta.
- **Exigir MCP no início** (`--require-mcp-startup`): falha a etapa cedo (exit 3) se um servidor MCP não iniciar.
- **Confiar em todas as ferramentas** (`--trust-all-tools`): ligado por padrão; desligado, vale a `allowedTools` do agente.
- **Orçamento de créditos (sessão)**: o bridge bloqueia novas etapas ao atingir o teto (HTTP 429).

### MCP como ferramenta
- **Painel “Servidores MCP”** na aba Kiro CLI mostra o `kiro-cli mcp list` (endpoint `GET /api/mcp`).
- **Presets prontos** em `.kiro/agents/`:
  - `dev-mcp` — MCP **Context7** (documentação ao vivo das libs). Pré-requisito: `npx` no PATH e `CONTEXT7_API_KEY` no ambiente do bridge.
  - `sec-mcp` — MCP **Semgrep** (SAST). Pré-requisito: `uvx` (do `uv`) no PATH.
- **Adicionar um servidor MCP** a um agente: edite o `.kiro/agents/<nome>.json` e inclua `mcpServers` + libere em `tools`/`allowedTools` com `@servidor`. Ex.:
  ```jsonc
  "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } },
  "tools": ["read", "write", "shell", "@playwright"],
  "allowedTools": ["read", "@playwright"]
  ```
  Valide com `npm run agents:validate`. Gerencie servidores globais com `kiro-cli mcp add/list/status`.
- **Catálogo sugerido** (URLs em `../ADDONS_SQUAD_CODE.md`): Context7, Serena, filesystem/git/github oficiais, Playwright, postgres/sqlite, Semgrep/Trivy, HexStrike (pentest, só em container), AWS/Cloudflare.

### Scorecard de custo/uso
- `GET /api/stats` agrega créditos do histórico (`json_extract` sobre os eventos salvos): totais, por agente, por dia, por projeto, por feature.
- Painel **“Custo / uso (créditos)”** na aba Kiro CLI (inclui custo por feature).

### Memória / busca no histórico
- `GET /api/search?q=` faz **busca léxica (FTS5)** nos resultados de todas as execuções; indexado em cada `finishRun`, com backfill do histórico existente. Degrada com elegância se o build do SQLite não tiver FTS5 (a busca fica vazia, o banco abre normal).
- Painel **“Memória / busca no histórico”** na aba Kiro CLI. Teste determinístico (sem custo) em `npm test` (`tests/search.manual.cjs`).

## Próximos passos (prontos para implementar; dependem de pré-requisito)

### Resume de sessão — NÃO funciona em one-shot headless (testado)
O engine e o bridge aceitam `resumeId` (vira `--resume-id`), mas um **teste real** mostrou que retomar o `sessionId` de um run headless `stream-json` **falha**: o segundo run com `--resume-id <sessionId do run anterior>` não continua a conversa (o processo falha). Ou seja, o `sessionId` de runs one-shot não é resumível assim. Conclusão: **não** ligar `resumeId` no fluxo de etapas/chat — quebraria as mensagens seguintes. Para iteração contínua de verdade, o caminho é migrar o chat para o modo **ACP multi-turn** (`kiro-cli acp`), que é uma evolução estrutural do bridge. A flag `--resume-id` fica plumbada (e coberta por teste no nível de montagem do comando) para quando/se o modo ACP for adotado.

### Memória / RAG vetorial (upgrade opcional)
A **memória léxica (FTS5)** já está implementada (veja acima) — sem dependência nova. O upgrade para **RAG vetorial** (busca semântica) é opcional e precisa de: `npm i sqlite-vec` (binários prontos, carregado no `better-sqlite3`) **mais um provedor de embeddings** (um modelo local pesado, ex.: `@xenova/transformers`, ou uma API de embeddings com chave) para gerar os vetores — o kiro-cli não expõe embeddings. Enquanto não houver provedor de embeddings, o FTS5 cobre o caso de busca no histórico.

### Git worktree por agente + auto-commit + PR
- **Worktree:** cada etapa roda numa worktree isolada (`git worktree add`) em vez da pasta única — habilita paralelismo sem colisão. Dá para fazer com `git` cru (o bridge já roda `git init`), sem dependência nova. É uma mudança estrutural no `cwd` por run.
- **Auto-commit:** após uma etapa verde, `git add -A && git commit` na worktree (requer `user.name/email` do git configurados).
- **PR automático:** `POST` na API do GitHub (`/repos/{owner}/{repo}/pulls`) com o diff da branch. **Pré-requisito:** `GITHUB_TOKEN` (PAT com escopo de PR) no ambiente do bridge.

### Sandbox de execução (pentest/labs)
Não existe `--sandbox` nativo no `kiro-cli chat` (só `--cloud`, que roda na nuvem do Kiro). Para isolamento local de execuções ofensivas/descartáveis, rode a etapa dentro de um container (Docker) ou microVM (microsandbox/E2B) — a bridge pode fazer `spawn` do `kiro-cli` dentro do container. **Pré-requisito:** Docker (ou runtime de microVM) instalado. Use com o `pentest-operator` e a toolbox MCP (HexStrike) em rede isolada.

### Motor persistente (`kiro-cli serve`)
`kiro-cli serve` sobe um servidor WebSocket do engine v3 (porta padrão 8082). Dá para trocar o “spawn por etapa” por uma conexão persistente — menor latência e multi-turn de verdade. É uma evolução estrutural do bridge (opcional).

### Notificações / agendamento
`kiro-cli crew` (backend 24/7) e Global Hooks (`~/.kiro/hooks/`) permitem disparos pós-run (Slack/Discord/e-mail) e tarefas agendadas (cron) sem tocar na SPA.
