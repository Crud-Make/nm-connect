# Banco de processos do escritório

Supabase **separado** do NM Connect. É o dossiê do escritório: pessoas, clientes (PF e PJ), processos, andamentos revisados e documentos. O NM Connect só lê este banco, pelo conector de banco externo, e só enxerga o schema `ia`. Desenho completo e decisões na issue #18.

| Schema | O que tem | Quem alcança |
|---|---|---|
| `escritorio` | tabelas reais: `pessoas`, `clientes`, `cliente_pessoas`, `processos`, `cliente_processo`, `andamentos`, `documentos` | só o dono do banco (equipe) |
| `ia` | views `ia.processos` e `ia.andamentos`, função `ia.conferir_cpf` | papel `crm_leitor` (NM Connect) |

Regras que o banco garante (testadas em `teste.sql`):

- **Pessoa é quem fala no WhatsApp; cliente é quem contrata** (PF ou PJ). Na PF, a pessoa é `titular`. Na PJ, sócio, representante, contador ou financeiro são pessoas autorizadas, e todas veem os processos da empresa.
- **Telefone obrigatório** em E.164 e **único por pessoa**, inclusive escrito com e sem o nono dígito.
- **Só os 3 últimos dígitos do CPF de quem fala** (`pessoas.cpf_confere`). O CPF inteiro é recusado. Na PJ confere o CPF da pessoa autorizada, não o CNPJ.
- **CNPJ só na PJ**, com 14 dígitos e sem repetição.
- **Documentos** (RG, CNIS, procuração, contrato…) ficam num bucket privado; a tabela guarda o ponteiro. Documento ligado a processo tem de ser processo do mesmo cliente. A IA não enxerga documentos.
- **Andamento liberado exige revisor e data de revisão.** Se o texto mudar depois de liberado, ele volta para revisão sozinho.
- **As views mostram só andamentos liberados.** Cada processo aparece nas duas grafias do telefone, para o filtro do conector casar.
- **O `crm_leitor` não lê as tabelas de `escritorio`**, nem vê coluna de CPF ou CNPJ. A conferência do CPF devolve só `true`/`false`, e só para o dono do telefone.

## Testar

```bash
infra/nm-processos/testar.sh                              # Postgres 17 descartável
PG_IMAGEM=postgres:15-alpine infra/nm-processos/testar.sh
```

O script aplica `001_base.sql` duas vezes, para provar que o schema é idempotente, e roda `teste.sql` dentro de uma transação que termina em `ROLLBACK`.

## Aplicar no Supabase (ainda não feito)

1. No SQL Editor do projeto, colar e rodar `001_base.sql`.
2. Definir a senha do papel de leitura. Este comando fica fora do git:
   `alter role crm_leitor password '<senha forte>';`
3. No NM Connect, em **Integração de dados**, criar a conexão com:
   - usuário `crm_leitor.<ref-do-projeto>`;
   - host do pooler (IPv4);
   - coluna do cliente `telefone`, tipo telefone. **Obrigatória**: sem ela a IA lê a view inteira (achado B2).

O texto do andamento para o cliente vem da entrada por e-mail (portada do NM ONE). Esse texto passa pela aprovação do advogado e só então é liberado. As duas etapas estão na issue #18.
