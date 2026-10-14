# Testes locais limpos (NM)

`scripts/nm/testes-locais.sh` roda `typecheck`, `lint` e a suíte unitária na máquina
do dev e sai 0 quando o código está bom — sem os vermelhos que vêm só do ambiente.
Não altera nada do upstream (`package.json`, `vitest.config.ts`,
`tests/setup/vitest.setup.ts` ficam intocados).

## Por que existe

Com o `.env.local` de quem tem a stack local, `pnpm test:unit` saía 1 com 13 casos
vermelhos em 8 arquivos (medido em 14/10/2026), nenhum por defeito de código:

| Causa | Arquivos | O que o script faz |
|---|---|---|
| `UPSTASH_REDIS_REST_URL`/`TOKEN` apontam para o `serverless-redis-http` local; sem ele de pé, timeout | `lib/ai/dispatcher/rate-limit.test.ts` | remove as duas variáveis → contador em memória, como no CI |
| Testes que esperam o ambiente do CI, sem a variável | `janela-24h-recusa-quem-envia-por-token` (`WAHA_API_BASE_URL`), `roteador-grava-o-roteiro` (`SUPABASE_DB_URL`), `permissao-lida-no-primeiro-render` (`VAPID_PUBLIC_KEY`) | remove as variáveis |
| Cercas que estouram 15 s sob carga e passam isoladas | 4 cercas (7 numa rodada com outra suíte rodando ao lado) | roda o projeto `cercas` numa passada própria, antes do `produto`, e limita os workers (padrão 2) |
| `tsc` estoura o heap padrão | typecheck | `NODE_OPTIONS=--max-old-space-size=6144` |

Também força Node 22 via `fnm` (o default da máquina pode ser outro).

## Como a neutralização funciona

O `tests/setup/vitest.setup.ts` lê `.env` e `.env.local` do diretório atual e só
preserva variável que já existe **com valor não vazio** (`!process.env[key]`).
Exportar vazio no shell, portanto, não adianta: o arquivo sobrescreve.

Por isso o script usa uma config própria, `scripts/nm/vitest.testes-locais.config.ts`,
que é a do upstream mais um setup extra (`scripts/nm/neutraliza-env.setup.ts`). Ele
roda depois do setup do upstream e apaga do `process.env` as chaves listadas em
`NM_ENV_NEUTRALIZADAS`. O `.env.local` não é lido nem alterado pelo script, e a stack
local não é tocada.

## Como usar

```bash
scripts/nm/testes-locais.sh               # typecheck + lint + unit
scripts/nm/testes-locais.sh --so-unit     # só cercas + produto (ou --so-typecheck, --so-lint)
scripts/nm/testes-locais.sh --workers 3   # muda o paralelismo (ou NM_TESTES_WORKERS=3)
```

Os logs ficam num diretório temporário fora do repositório (impresso no início).
Os passos são `typecheck`, `lint`, `cercas` e `produto`; os dois últimos são os dois
projetos do `vitest.config.ts` e, juntos, cobrem o mesmo conjunto que `pnpm test:unit`.
No fim saem o exit de cada passo, o rodapé do vitest (`Test Files`/`Tests`/`Errors`) e
a conferência cruzada do `grep FAIL`, como pede a seção "Testes" do `CLAUDE.md`.
O exit do script é 0 só se todos os passos saíram 0.

Rodar duas suítes ao mesmo tempo na máquina (outra sessão, outra worktree) volta a
estourar os 15 s das cercas: o timeout mede a disputa por CPU, não o código.

Ressalva: isto **não** substitui o `verify` do CI nem o `pnpm test:db`. Um vermelho que
sobrar aqui não é de ambiente; investigue.
