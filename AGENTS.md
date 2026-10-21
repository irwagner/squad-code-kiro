# AGENTS.md

Guia de contexto para agentes e contribuidores do **SQUAD/CODE**. Este arquivo é carregado como contexto pelos agentes do `.kiro/agents/` (campo `resources`). Mantenha-o curto e objetivo.

## O que é o projeto

SQUAD/CODE é uma interface web (app de página única + bridge Node.js local + SQLite) que monta e comanda um **squad de agentes de desenvolvimento de software**. Os agentes executam tarefas de verdade com o **Kiro CLI em modo headless** (`kiro-cli chat --no-interactive --output-format stream-json`), e a UI acompanha cada etapa.

- Texto de UI em português (pt-BR); identificadores de código em inglês.
- Única dependência npm: `better-sqlite3` (banco local).
- O bridge (`server.js`) faz `spawn` do `kiro-cli` por etapa e traduz os eventos ACP para a UI (`kiro-engine.js`).

## Onde os agentes trabalham

- Cada operação tem a sua pasta em `projects/<pasta>/`. **Trabalhe SOMENTE dentro da pasta do projeto** (working directory): não leia nem escreva fora dela.
- Cada pasta de projeto é um repositório git próprio.
- Avaliações de segurança usam `engagements/<nome>/` para escopo/autorização e relatório.

## Diretrizes de engenharia (padrão)

- Siga o estilo, as convenções e as bibliotecas já existentes no projeto antes de introduzir algo novo.
- Segurança por padrão: validação de entrada, consultas parametrizadas, tratamento de erros, sem segredos no cliente ou no versionamento.
- Escreva e **rode** os testes relevantes; rode o build/lint antes de concluir. Corrija falhas antes de entregar.
- Ações de alto risco (deploy em produção, infraestrutura viva, exclusão de dados, operações git destrutivas) exigem aprovação humana: descreva e **pare**, não execute.
- Entregue sempre um resumo curto: o que mudou, quais arquivos, como testou, o que ficou pendente.

## Squads disponíveis (`.kiro/agents/`)

- **Dev:** `squad-commander` (planeja), `squad-recon` (PRD/ADR), `squad-backend`, `squad-frontend`, `squad-qa`, `squad-devops`.
- **Produto:** `saas-architect` (arquitetura/scaffolding de SaaS), `lab-builder` (labs descartáveis).
- **Pentest (alvos próprios ou autorizados):** `pentest-recon`, `pentest-analyst`, `pentest-operator` (exploração ativa) e `pentest-reporter`. Registre o escopo em `engagements/<nome>/scope.md`.

Veja `.kiro/agents/README.md` para o modelo de segurança e como usar cada squad.
