#!/usr/bin/env bash
# Atualiza a stack local NM com as imagens que o GitHub já construiu (workflow
# nm-imagens): baixa app, worker e scheduler e recria os três. Não compila nada.
# Contexto: docs/nm/sem-waha.md
#
# Uso: scripts/nm/atualizar-stack-local.sh
#      NM_IMAGEM_TAG=sha-1a2b3c4 scripts/nm/atualizar-stack-local.sh   # um commit
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE=(docker compose -f docker-compose.local.yml -f docker-compose.local.nm.yml
  --env-file "${LOCAL_ENV_FILE:-.env.local}")
SERVICOS=(app worker scheduler)

# As chaves de cifra vivem no banco; um banco recriado volta sem elas.
./scripts/local-stack.sh chaves
"${COMPOSE[@]}" pull "${SERVICOS[@]}"
# Sem `--no-build`, um pull que falha no `up` (rede, pacote privado) cai no
# `build:` do local.yml e compila tudo nesta máquina.
"${COMPOSE[@]}" up -d --no-build "${SERVICOS[@]}"
