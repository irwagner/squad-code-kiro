# engagements/

Pasta de trabalho dos **engajamentos de pentest**. Cada avaliação autorizada fica em `engagements/<nome>/` com, no mínimo, um `scope.md` (escopo + autorização) e, ao final, um `report.md`.

- Comece copiando `_template/` para `engagements/<nome>/` e preenchendo o `scope.md`.
- Os agentes de pentest (`.kiro/agents/pentest-*.json`) **leem** `engagements/<nome>/scope.md` e se recusam a agir sem escopo e autorização confirmados.
- Testes ativos (`pentest-operator`) só em **ambiente isolado** (sandbox/lab) e contra alvos próprios ou com autorização escrita.

Por conterem dados sensíveis (autorizações, achados), os engajamentos **não são versionados** — só o `_template/` e este README (veja `.gitignore`).
