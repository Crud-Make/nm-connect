#!/usr/bin/env bash
# Lê caminhos (um por linha) na entrada e responde duas linhas:
#   suites=sim|nao   — as partes 1–3 do nm-ci (typecheck, lint, cercas, unit)
#   banco=sim|nao    — as partes 4–6 (test:db em 3 partes + test:db:update)
# `nao` só quando TODOS os caminhos estão na lista da suíte. Entrada vazia
# responde `sim` nas duas: não saber o que mudou nunca pode virar "não precisa".
#
# Mesmo desenho de scripts/pr-alcanca-o-e2e.sh: a lista é de quem NÃO alcança,
# e cada entrada foi MEDIDA (grep dos testes em 21/10/2026), não suposta. Errar
# para "rodar" custa minutos; errar para "pular" deixa passar regressão com o
# `nm-ci-ok` verde.
#
#   - marca/nm-connect/: nenhum teste, script ou código do produto lê a pasta
#     (a marca entra pela tela /admin/marca, no banco). Pula as duas.
#   - .changes/ e tests/cercas/: nenhuma invariante de banco os lê, então pulam
#     só o test:db. As suítes rodam: há cercas que validam os fragmentos.
#
# docs/, *.md, evidence/ e tasks/ NÃO estão aqui: 215 arquivos de teste leem
# documentação (mapas de arquitetura, afirmações de estado, evidência citada).
set -euo pipefail

suites=nao
banco=nao
algum=nao
while IFS= read -r caminho || [ -n "$caminho" ]; do
  [ -z "$caminho" ] && continue
  algum=sim
  case "$caminho" in
    marca/nm-connect/*) ;;
    .changes/* | tests/cercas/*) suites=sim ;;
    *) suites=sim; banco=sim ;;
  esac
done

if [ "$algum" = nao ]; then
  suites=sim
  banco=sim
fi
echo "suites=${suites}"
echo "banco=${banco}"
