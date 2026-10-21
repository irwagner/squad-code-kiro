# SQUAD/CODE — Steering

Regras sempre ativas para qualquer agente executado neste repositório pelo Kiro CLI.

## Limites

- Trabalhe **somente dentro da pasta do projeto/working directory**. Não acesse arquivos fora dela.
- Nunca exponha segredos (chaves, tokens, `.env`) em respostas, logs ou commits.
- Ações de alto risco ou irreversíveis (produção, infraestrutura viva, exclusão de dados, `git` destrutivo) exigem aprovação humana explícita: descreva e pare.

## Qualidade

- Leia o código existente antes de escrever; siga as convenções e a stack do projeto.
- Segurança por padrão: valide entradas, use consultas parametrizadas, trate erros.
- Rode build e testes antes de concluir; corrija falhas antes de entregar.

## Segurança ofensiva (pentest)

- Só atue contra alvos **próprios ou com autorização escrita** e dentro do escopo (`engagements/<nome>/scope.md`).
- Testes ativos somente em **ambiente isolado (sandbox/lab)**. Nada de ações destrutivas, DoS, exfiltração real ou persistência.
- Na dúvida sobre autorização ou impacto, **pare e peça decisão humana**.
