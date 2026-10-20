#!/usr/bin/env bash
# Checagem de duplicação (NM, regra DRY): roda o jscpd nas pastas dos .ts/.tsx que
# este branch mudou em relação à main e olha só os clones que tocam esses arquivos.
#   - clone num arquivo NOVO reprova (exit 1): código novo nasce sem repetição;
#   - clone num arquivo que já existia só avisa: a dívida antiga do upstream não trava o PR.
# Contexto: seção "Regras NM" do CLAUDE.md.
#
# Uso: scripts/nm/checar-duplicacao.sh [ref-base]   (padrão: origin/main)
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RAIZ"

BASE="${1:-origin/main}"
MIN_TOKENS=60
JSCPD="jscpd@4.0.5"

# No CI o checkout é raso: sem a base, não há com o que comparar.
git rev-parse --verify --quiet "$BASE" >/dev/null || git fetch --quiet --depth=1 origin main

# Fora da checagem: testes (repetição de arranjo é esperada) e arquivos gerados.
mudados() {
  git diff --name-only --diff-filter="$1" "$BASE" -- '*.ts' '*.tsx' \
    | grep -vE '\.test\.tsx?$|(^|/)database\.types\.ts$' || true
}
mapfile -t NOVOS < <(mudados A)
mapfile -t ALTERADOS < <(mudados M)
TODOS=("${NOVOS[@]}" "${ALTERADOS[@]}")
if [[ ${#TODOS[@]} -eq 0 ]]; then
  echo "checar-duplicacao: nenhum .ts/.tsx mudado em relação a $BASE."
  exit 0
fi

RELATORIO_DIR="$(mktemp -d)"
trap 'rm -rf "$RELATORIO_DIR"' EXIT

# Varre o código todo (~1min30): o clone de um arquivo novo costuma estar em OUTRA
# pasta, e olhar só a vizinhança deixava passar exatamente esse caso.
pnpm dlx "$JSCPD" --silent --min-tokens "$MIN_TOKENS" --reporters json --format typescript,tsx \
  --output "$RELATORIO_DIR" --ignore "**/*.test.ts,**/*.test.tsx,**/node_modules/**,**/database.types.ts" \
  lib app components hooks workers >/dev/null

# Uma linha por clone que toca um arquivo do conjunto: "arquivo|outro lado".
clones_de() {
  # Com --args, todo argumento depois do filtro vira posicional: o relatório entra pelo stdin.
  jq -r --args '
    ($ARGS.positional) as $alvo
    | .duplicates[]
    | [.firstFile, .secondFile] as $lados
    | $lados[] | select(.name | IN($alvo[]))
    | "\(.name):\(.start)-\(.end)|\(($lados - [.])[0] | "\(.name):\(.start)-\(.end)")"
  ' "$@" < "$RELATORIO_DIR/jscpd-report.json" | sort -u
}

relatar() {
  local nivel="$1" titulo="$2"; shift 2
  [[ $# -eq 0 ]] && return 0
  echo "$titulo"
  local linha
  for linha in "$@"; do
    local aqui="${linha%%|*}" la="${linha#*|}"
    echo "  $aqui  =  $la"
    # Anotação no PR quando roda no GitHub Actions.
    [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::$nivel file=${aqui%%:*}::trecho repetido com $la (jscpd, ≥$MIN_TOKENS tokens)"
  done
}

mapfile -t CLONES_NOVOS < <([[ ${#NOVOS[@]} -gt 0 ]] && clones_de "${NOVOS[@]}")
mapfile -t CLONES_ALTERADOS < <([[ ${#ALTERADOS[@]} -gt 0 ]] && clones_de "${ALTERADOS[@]}")

relatar warning "Aviso: repetição em arquivo que já existia (não reprova):" "${CLONES_ALTERADOS[@]}"
relatar error "Reprovado: código repetido em arquivo novo. Extraia para uma função compartilhada ou reaproveite a existente:" "${CLONES_NOVOS[@]}"

[[ ${#CLONES_NOVOS[@]} -eq 0 ]] || exit 1
echo "checar-duplicacao: OK (${#TODOS[@]} arquivo(s) conferido(s), mínimo de $MIN_TOKENS tokens)."
