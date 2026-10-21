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

### Git: auto-commit (IMPLEMENTADO) + worktree + PR
- **Auto-commit — IMPLEMENTADO (opt-in):** marque **"Auto-commit após cada etapa"** nas configurações. Quando uma etapa conclui com sucesso, o bridge faz `git add -A && git commit` na pasta do projeto (que já é um repo git), com identidade git **local** (nunca toca a config global); "nada a commitar" conta como sucesso e **nunca falha o run** (try/catch, evento `bridge/commit` no stream). Verificado por teste real (run grava arquivo → commit nasce no repo do projeto).
- **Worktree por agente — IMPLEMENTADO (opt-in):** marque **"Worktree isolada por etapa"**. Cada run cria uma worktree git + branch `squad/<id>`, executa isolado (paralelismo sem colisão), commita o trabalho no branch e remove a worktree ao fim (o branch permanece). Fallback gracioso: se o git falhar, roda na pasta normal sem derrubar o run. Verificado por teste real (árvore principal limpa; arquivo só no branch; worktree removida).
- **Branches das etapas (merge local) — IMPLEMENTADO:** painel **"Branches das etapas (worktree)"** nas configurações lista os branches `squad/<id>` do projeto atual e permite **ver o diff** (patch colorido), **merge** na árvore principal (aborta limpo em conflito) ou **excluir** — o "PR local" para o modelo de repositório local. Endpoints `GET /api/branches`, `GET /api/branches/diff` e `POST /api/branches/merge|delete` (restritos a `squad/*`). Verificado por teste determinístico.
- **PR automático no GitHub (próximo):** exige que a pasta da operação seja um repo com **remote no GitHub** (os repos de projeto hoje são locais) + `GITHUB_TOKEN` no bridge. Com worktree, o PR sai do branch `squad/<id>`.

### Sandbox de execução (pentest/labs)
Não existe `--sandbox` nativo no `kiro-cli chat` (só `--cloud`, que roda na nuvem do Kiro). Para isolamento local de execuções ofensivas/descartáveis, rode a etapa dentro de um container (Docker) ou microVM (microsandbox/E2B) — a bridge pode fazer `spawn` do `kiro-cli` dentro do container. **Pré-requisito:** Docker (ou runtime de microVM) instalado. Use com o `pentest-operator` e a toolbox MCP (HexStrike) em rede isolada.

### Motor persistente (`kiro-cli serve`)
`kiro-cli serve` sobe um servidor WebSocket do engine v3 (porta padrão 8082). Dá para trocar o “spawn por etapa” por uma conexão persistente — menor latência e multi-turn de verdade. É uma evolução estrutural do bridge (opcional).

### Notificações / agendamento
`kiro-cli crew` (backend 24/7) e Global Hooks (`~/.kiro/hooks/`) permitem disparos pós-run (Slack/Discord/e-mail) e tarefas agendadas (cron) sem tocar na SPA.
