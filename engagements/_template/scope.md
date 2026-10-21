# Escopo e Autorização do Engajamento — TEMPLATE

> Copie esta pasta para `engagements/<nome-do-engajamento>/` e preencha antes de qualquer atividade.
> Os agentes de pentest LEEM este arquivo e se recusam a agir sem escopo e autorização confirmados.

## Autorização

- **Responsável autorizador:** <nome / cargo>
- **Autorização escrita:** <link/arquivo/ref. do documento assinado>
- **Período autorizado:** <início> a <fim>
- **Confirmação:** Eu confirmo que possuo ou tenho autorização por escrito para testar os alvos abaixo. ( ) Sim

## Escopo (in-scope)

- Alvos (hosts/domínios/faixas/apps): <lista>
- Ambientes: <lab isolado / homologação / etc.>
- Técnicas permitidas: <recon passivo / varredura ativa / exploração com PoC mínima / ...>

## Fora de escopo (out-of-scope)

- Alvos proibidos: <lista — tudo que não estiver explicitamente in-scope é proibido>
- Técnicas proibidas: DoS, ações destrutivas, exfiltração de dados reais, persistência, engenharia social (salvo se explicitamente autorizado).

## Regras de engajamento (ROE)

- Janela de testes: <horários>
- Contato de emergência: <nome / canal>
- Tratamento de dados sensíveis encontrados: <procedimento>
- Credenciais: use apenas as fornecidas para o lab/escopo; nunca credenciais reais de produção.

## Notas

- Este diretório (exceto `_template/`) deve ficar fora do versionamento público — veja `.gitignore`.
