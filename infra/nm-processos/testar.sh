#!/usr/bin/env bash
# Sobe um Postgres descartável, aplica o schema do banco de processos duas vezes
# (a segunda prova que ele é idempotente) e roda teste.sql. Nada fica de pé.
#
# Uso: infra/nm-processos/testar.sh            (Postgres 17, o do Supabase novo)
#      PG_IMAGEM=postgres:15 infra/nm-processos/testar.sh
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
imagem="${PG_IMAGEM:-postgres:17}"
nome="nm-processos-teste-$$"

docker run -d --rm --name "$nome" -e POSTGRES_PASSWORD=teste "$imagem" >/dev/null
trap 'docker rm -f "$nome" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  docker exec "$nome" pg_isready -U postgres -q && break
  sleep 1
done

psql_() { docker exec -i "$nome" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql_ < "$dir/001_base.sql"
psql_ < "$dir/001_base.sql"
psql_ < "$dir/teste.sql"
