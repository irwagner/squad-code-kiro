# Templates de operação

Blueprints prontos para começar uma operação no SQUAD/CODE. Crie uma **Nova operação**, escolha a squad e **cole o briefing/visão/escopo** abaixo; cada etapa roda com o agente `.kiro/agents` indicado. Dica: ligue **Worktree isolada por etapa** (isola cada feature num branch `squad/<id>`) e, para pentest, mantenha o escopo em `engagements/<nome>/scope.md`.

Modelos sugeridos (créditos): dia a dia `auto` (1x) ou `claude-sonnet-4.5` (1,3x); planejamento/arquitetura `claude-opus-4.5` (2,2x); tarefas simples `claude-haiku-4.5` (0,4x). Liste todos com `kiro-cli chat --list-models`.

---

## 1. Sistema / app (dev geral)

- **Squad (.kiro/agents):** `squad-commander` → `squad-recon` → `squad-backend` + `squad-frontend` → `squad-qa` → `squad-devops`.
- **Trust:** ligado (dev confiável). **Worktree:** recomendado. **Auto-commit:** recomendado.
- **Briefing (colar):** "Construir <nome do sistema>: <o que faz, para quem>. Stack sugerida: <ex.: Node/React/Postgres>. Entregar um fluxo de ponta a ponta funcionando, com testes."
- **Visão:** objetivo do produto + metas da 1ª entrega (MVP enxuto).
- **Escopo:** dentro = <features do MVP>; fora = <o que fica para depois>.
- **Features sugeridas:** F00 Setup do projeto · Autenticação · Modelo de dados + migrações · API CRUD do domínio · UI principal + estados de erro/carregamento · Testes e CI.

## 2. SaaS (multi-tenant)

- **Squad:** `saas-architect` (arquitetura + scaffolding) → `squad-backend` + `squad-frontend` → `squad-qa` → `squad-devops`.
- **Trust:** ligado. **Worktree:** recomendado. **Modelo do arquiteto:** `claude-opus-4.5`.
- **Briefing:** "SaaS <nome> para <público>. Multi-tenant, assinatura/cobrança, e limites de uso por plano."
- **Visão:** "Clientes assinam, criam sua conta (tenant), convidam o time e usam <núcleo do produto>; cobrança recorrente e limites por plano."
- **Escopo:** dentro = auth + tenancy + billing + core; fora = white-label, SSO empresarial, data residency (fases seguintes).
- **Decisões a registrar (ADR):** isolamento de tenants (linha/schema/banco); auth (sessões/JWT/OAuth); billing (assinatura/uso); segredos por ambiente.
- **Features sugeridas:** F00 Setup · Tenancy + isolamento · Auth + convites/papéis · Billing (planos, webhook de pagamento) · Limites/quotas por plano · Painel do tenant · Testes de isolamento entre tenants.

## 3. Lab (ambiente descartável)

- **Squad:** `lab-builder` (provisiona) → `squad-qa` (valida) — opcional `squad-devops`.
- **Trust:** ligado. **Worktree:** opcional. **Isolamento:** rode o bridge/execução dentro de um container quando o lab for de rede/segurança.
- **Briefing:** "Lab reprodutível de <tema> (ex.: web vulnerável, stack de dados, cluster local). Um comando para subir, um para destruir; só dados sintéticos; isolado da máquina host."
- **Visão:** "Ambiente efêmero para estudo/teste/treino, reconstruível do zero, sem credenciais reais e sem exposição à internet por padrão."
- **Escopo:** dentro = containers/compose + seeds + scripts up/down + README; fora = qualquer dado real ou acesso a produção.
- **Features sugeridas:** F00 Setup · Definição de containers (Dockerfile/compose) · Seeds sintéticos · Serviços de apoio · Scripts up/down · README do lab (subir/usar/destruir).

## 4. Pentest (avaliação autorizada)

> ⚠️ Só contra alvos **próprios ou com autorização escrita**. Preencha `engagements/<nome>/scope.md` (template em `engagements/_template/`) antes de começar. Rode a exploração ativa **em sandbox/lab isolado**.

- **Squad:** `pentest-recon` → `pentest-analyst` (ou `sec-mcp` com Semgrep) → `pentest-operator` (ativo, sandbox) → `pentest-reporter`.
- **Trust:** avalie por agente; para a toolbox ativa, prefira container isolado. **Worktree:** opcional (isola artefatos por etapa).
- **Briefing:** "Pentest autorizado de <alvo/app/rede>. Escopo e janela em engagements/<nome>/scope.md. Objetivo: encontrar, validar e reportar vulnerabilidades com PoC mínima e recomendações."
- **Visão:** "Equipe que faz recon → análise → exploração controlada → relatório, priorizando risco e correção, sem ações destrutivas e dentro do escopo."
- **Escopo:** dentro = alvos/técnicas autorizados; fora = DoS, exfiltração real, persistência, fora do escopo.
- **Features/etapas sugeridas:** Recon (superfície de ataque) · Análise de vulnerabilidades (SAST/scanners) · Exploração com PoC mínima (sandbox) · Validação dos achados · Relatório (`engagements/<nome>/report.md`).
- **MCP útil:** `sec-mcp` (Semgrep). Toolbox ofensiva (nmap/nuclei/ffuf) via MCP (ex.: HexStrike) **só em container isolado** — veja `docs/ADDONS.md` e `.kiro/agents/README.md`.
