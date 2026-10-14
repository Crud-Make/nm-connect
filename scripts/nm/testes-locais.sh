#!/usr/bin/env bash
# Testes locais limpos (NM): typecheck + lint + test:unit na máquina do dev,
# sem o .env.local vazar para dentro da suíte. Não edita nada do upstream.
# Contexto e motivos: docs/nm/testes-locais.md
#
# Uso: scripts/nm/testes-locais.sh [--so-typecheck|--so-lint|--so-unit] [--workers N]
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RAIZ"

# A suíte unitária roda em duas passadas, uma por projeto do vitest.config.ts:
# as cercas (CPU pesada, ambiente node) estouravam os 15 s quando disputavam a
# máquina com os workers jsdom do projeto produto. Juntas, as duas passadas
# cobrem exatamente o que `pnpm test:unit` cobre.
PASSOS=(typecheck lint cercas produto)
WORKERS="${NM_TESTES_WORKERS:-2}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --so-typecheck) PASSOS=(typecheck) ;;
    --so-lint) PASSOS=(lint) ;;
    --so-unit) PASSOS=(cercas produto) ;;
    --workers) WORKERS="${2:?--workers precisa de um número}"; shift ;;
    -h | --help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

# Node 22 é o do projeto; o default da máquina pode ser outro.
command -v fnm > /dev/null || { echo "fnm não encontrado" >&2; exit 2; }
NODE22=(fnm exec --using=22)
"${NODE22[@]}" node --version > /dev/null

# O typecheck estoura o heap padrão.
export NODE_OPTIONS="--max-old-space-size=6144"

# Variáveis do .env.local que mudam o caminho de testes que esperam o ambiente
# do CI (sem elas). Removidas só dentro do processo de teste, por
# scripts/nm/neutraliza-env.setup.ts — exportar vazio não serve, porque o
# tests/setup/vitest.setup.ts sobrescreve variável vazia com a do arquivo.
export NM_ENV_NEUTRALIZADAS="WAHA_API_BASE_URL,SUPABASE_DB_URL,VAPID_PUBLIC_KEY,UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN"

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/nm-testes-locais.XXXXXX")"
echo "logs em: $LOGS"

declare -A EXIT
declare -A DURACAO
for passo in "${PASSOS[@]}"; do
  log="$LOGS/$passo.log"
  inicio=$SECONDS
  echo "==> $passo ..."
  set +e
  case "$passo" in
    typecheck) "${NODE22[@]}" pnpm typecheck > "$log" 2>&1 ;;
    lint) "${NODE22[@]}" pnpm lint > "$log" 2>&1 ;;
    cercas | produto)
      "${NODE22[@]}" pnpm exec vitest run \
        -c scripts/nm/vitest.testes-locais.config.ts \
        --project "$passo" --maxWorkers="$WORKERS" > "$log" 2>&1
      ;;
  esac
  EXIT[$passo]=$?
  set -e
  DURACAO[$passo]=$((SECONDS - inicio))
  echo "    exit=${EXIT[$passo]} (${DURACAO[$passo]}s)"
done

echo
echo "================ resumo ================"
final=0
for passo in "${PASSOS[@]}"; do
  echo "$passo: exit=${EXIT[$passo]} (${DURACAO[$passo]}s) log=$LOGS/$passo.log"
  [[ "${EXIT[$passo]}" -ne 0 ]] && final=1
  if [[ "$passo" == cercas || "$passo" == produto ]]; then
    log="$LOGS/$passo.log"
    # Rodapé é a autoridade (junto do exit); grep FAIL é conferência.
    grep -aE "^ *(Test Files|Tests|Errors) " "$log" | tail -3 | sed 's/^/    /' || true
    grep -aqE "^ *Test Files" "$log" || echo "    ATENÇÃO: log sem rodapé (truncado?) — o zero não vale"
    r=$(grep -aE "^ *Tests " "$log" | tail -1 | grep -oE "[0-9]+ failed" | head -1 || true)
    g=$(grep -acE "^ *FAIL " "$log" || true)
    s=$(grep -aoE "Failed Suites [0-9]+" "$log" | grep -oE "[0-9]+" || true)
    echo "    rodapé: ${r:-0 failed} | grep FAIL contou: $g | Failed Suites: ${s:-0}"
    grep -aE "^ *FAIL " "$log" | sed 's/ > .*//' | sort | uniq -c | sed 's/^/    /' || true
  elif [[ "${EXIT[$passo]}" -ne 0 ]]; then
    tail -20 "$LOGS/$passo.log" | sed 's/^/    /'
  fi
done
echo "========================================"
exit "$final"
