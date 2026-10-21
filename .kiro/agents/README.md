# Squads de Agentes (`.kiro/agents/`)

Presets de agentes nativos do Kiro, versionados no repositório. Cada arquivo `<nome>.json` define um papel: `prompt`, `tools` (teto de capacidade), `allowedTools` (pré-aprovados em modo headless), `model` e `resources` (contexto carregado).

Selecione um preset com a flag `--agent <nome>` do kiro-cli, ou pelo campo de agente nas configurações do SQUAD/CODE.

## Squads

### Desenvolvimento
| Agente | Papel | Capacidades |
|--------|-------|-------------|
| `squad-commander` | Planeja o sprint, divide em features/rotas | leitura + pesquisa (não edita código) |
| `squad-recon` | Escreve PRD e ADRs | leitura + escrita de docs + pesquisa |
| `squad-backend` | Implementa APIs/serviços + testes | leitura, escrita, shell, código |
| `squad-frontend` | Implementa UI + testes | leitura, escrita, shell, código |
| `squad-qa` | Escreve e roda testes, valida aceitação | leitura, escrita, shell, código |
| `squad-devops` | Build, CI/CD, IaC, observabilidade | leitura, escrita, shell, código, aws |

### Produto
| Agente | Papel |
|--------|-------|
| `saas-architect` | Arquitetura multi-tenant, auth, billing e scaffolding de SaaS |
| `lab-builder` | Labs descartáveis e reprodutíveis (containers/compose) |

### Pentest — alvos próprios ou autorizados
| Agente | Papel | Capacidades |
|--------|-------|-------------|
| `pentest-recon` | Recon passivo e ativo (OSINT, DNS, portas/serviços) | leitura, escrita, shell, web |
| `pentest-analyst` | Vulnerabilidades: revisão estática + scanners | leitura, escrita, shell, código, web |
| `pentest-operator` | Exploração de ponta a ponta (enum, exploit, pós-exploração, PoC) | leitura, escrita, shell, web |
| `pentest-reporter` | Consolida achados no relatório | leitura + escrita |

## Modelo de segurança

- **`allowedTools` governa o modo headless.** Ferramentas fora dessa lista não rodam sem aprovação — e em `--no-interactive` ninguém aprova, então ficam bloqueadas. O conjunto de cada papel está pré-aprovado.
- **O squad de pentest é operacional.** Os quatro papéis têm as ferramentas de que precisam (incluindo `shell`) para recon, análise, exploração e relatório. Use apenas contra **alvos próprios ou com autorização escrita**; registre o escopo em `engagements/<nome>/scope.md` (template em `engagements/_template/`).
- **Prefira um ambiente isolado para exploração ativa.** Rode o `pentest-operator` num lab/sandbox sem acesso a produção (veja `lab-builder`). Evite ações destrutivas, DoS e exfiltração de dados reais; priorize a PoC mínima que comprova o risco.
- **`--trust-all-tools` confia em tudo.** Para restringir um papel, edite a `allowedTools` do preset em vez de depender do trust global.

## Uso

```sh
# Validar todos os presets
npm run agents:validate
# ou: kiro-cli agent validate --path .kiro/agents/squad-backend.json

# Rodar uma etapa com um agente (headless)
kiro-cli chat --no-interactive --output-format stream-json --agent squad-backend "implemente a feature X na pasta atual"

# Listar os agentes descobertos neste diretório
kiro-cli agent list
```

No SQUAD/CODE, o bridge (`server.js`) passa `--agent <nome>` ao kiro-cli conforme o papel do operador na rota da feature.

## Customização

- Ajuste o `model` por agente para controlar custo (ex.: `claude-haiku-4.5` ≈ 0.4x para tarefas simples; `auto` = 1.0x; `claude-sonnet-4.5` ≈ 1.3x para raciocínio pesado).
- Amplie/reduza `allowedTools` conforme a confiança no papel.
- Crie novos papéis copiando um preset: `kiro-cli agent create --from squad-backend --directory .kiro/agents <novo-nome>`.
