# KIRO.md

Guia para humanos e agentes que trabalham **neste repositório** com o Kiro CLI. Contexto de produto e diretrizes dos agentes: veja `AGENTS.md`. Presets de squad: veja `.kiro/agents/README.md`.

## O que é

SQUAD/CODE é um app de página única (servido por um bridge Node.js local) que orquestra um squad de agentes de desenvolvimento. Os agentes executam etapas de verdade com o **Kiro CLI em modo headless** (`kiro-cli chat --no-interactive --output-format stream-json`); o bridge traduz os eventos **ACP** do Kiro para o contrato de eventos que a UI já entende. Dados no SQLite local (`better-sqlite3`, única dependência npm). UI em pt-BR; identificadores de código em inglês.

## Comandos

```sh
npm install                 # better-sqlite3 (binário pronto; Node >= 22)
npm run dev                 # build do index.html a partir de src/, sobe o bridge, rebuild ao salvar
npm start                   # node server.js → http://127.0.0.1:4317
python build.py [--copy]    # build completo (regenera src/avatars.js com Pillow; --copy grava ../squad-code-kiro.html)
npm test                    # testes do adaptador ACP + pool de chaves (sem custo de API)
npm run test:e2e            # run REAL do kiro-cli de ponta a ponta (consome créditos; exige login)
npm run agents:validate     # valida todos os .kiro/agents/*.json com o kiro-cli
node --check src/app.js     # checagem rápida de sintaxe após editar
```

`index.html` é artefato de build — **não edite**; edite `src/` e rebuild. Abrir `index.html` via `file://` roda em modo demo (simulação determinística, sem bridge).

## Modelo de build e armadilhas

`build.py` / `scripts/dev.mjs` inlinam `src/styles.css` em `src/shell.html` e concatenam, **nesta ordem**, num único `<script>` clássico: `portraits.js`, `avatars.js`, `conventions.js`, `souls.js`, `vendor/three.min.js`, `city.js`, `app.js`. Consequências:
- Tudo compartilha um escopo global único.
- `app.js` inicializa o estado no load, então qualquer helper usado na inicialização precisa ser uma **function declaration** (hoisted); um `const` arrow definido depois causa `ReferenceError` (TDZ) e o app não sobe.
- `src/app.js` é denso, em linhas longas estilo minificado. Faça edições por **substituição de string exata e única** e rode `node --check`; não reformate o arquivo.
- Pipeline de assets: `scripts/build-avatars.py` transforma `assets/*.png` em data URLs em `src/avatars.js`.

## Como o Kiro é dirigido (específico desta migração)

- **`kiro-engine.js`** — adaptador: `buildKiroArgs` (monta o argv do kiro-cli), `makeAcpConverter` (traduz eventos ACP → eventos estilo Claude que a UI já consome), `classifyFailure`/`shouldRotate` (rotação de chaves), `describeExit` (diagnóstico de código de saída; **3 = falha de MCP**).
- **`server.js`** — bridge: faz `spawn` do kiro-cli por etapa, injeta `KIRO_API_KEY` por processo (pool), transmite eventos por SSE, trata timeout/erros e rotação. Binário: `SQUAD_KIRO_BIN || SQUAD_CLAUDE_BIN || 'kiro-cli'`.
- **`db.js`** — SQLite: workspace + histórico de execuções + **pool de API keys** (tabela `api_keys`, chaves mascaradas; raw nunca exposto).
- **Agentes**: `.kiro/agents/*.json` (formato universal). Selecionados com `--agent`. `allowedTools` governa o modo headless. Veja `.kiro/agents/README.md`.
- O **prompt** vai como argumento posicional (não stdin). Custo em **créditos**. Modelos: `kiro-cli chat --list-models` (padrão `auto`).

## Pré-requisitos do Kiro CLI

- Instale: macOS/Linux/WSL `curl -fsSL https://cli.kiro.dev/install | bash`; Windows: https://kiro.dev/downloads/. Autentique: `kiro-cli login`. Verifique: `kiro-cli --version`.
- Para o pool de `KIRO_API_KEY` ter efeito, rode `kiro-cli logout` antes (o CLI prefere o login salvo à variável de ambiente).
- Se `kiro-cli chat` (sem `--agent`) avisar que um agente default definido via `kiro-cli agent set-default` não existe, ele cai no default embutido; o bridge passa `--agent` explícito por etapa, então não afeta as execuções.

## Mais

- Guia completo da UI e funcionalidades: `docs/GUIA.md`.
- Pesquisa e roadmap da evolução (ondas de melhorias): `../SINTESE_FINAL_SQUAD_CODE.md`.
