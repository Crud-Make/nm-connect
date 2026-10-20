#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${LOCAL_ENV_FILE:-.env.local}"
COMPOSE=(docker compose -f docker-compose.local.yml --env-file "$ENV_FILE")

usage() {
  printf 'Uso: %s {up|down|restart|status|logs|supabase-status|reset|chaves}\n' "$0"
}

require_env() {
  if [[ ! -s "$ENV_FILE" ]]; then
    printf 'Erro: %s não existe. Execute ./ubuntu-local-installer.sh primeiro.\n' "$ENV_FILE" >&2
    exit 1
  fi
}

ensure_supabase() {
  if ! ./scripts/local-supabase.sh status >/dev/null 2>&1; then
    ./scripts/local-supabase.sh start
  fi
}

# Lê VAR do env file; ausente, gera com `openssl rand -hex 32` e acrescenta.
env_key() {
  local var="$1" key
  key="$(awk -F= -v var="$var" '$1 == var { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  if [[ -z "$key" ]]; then
    key="$(openssl rand -hex 32)"
    printf '\n%s=%s\n' "$var" "$key" >> "$ENV_FILE"
  fi
  printf '%s' "$key"
}

# As chaves de cifra moram no BANCO (private.app_secrets), que é de onde as
# funções as leem: `fn_encrypt_oauth` (0041) e `encrypt_cpf` (0597). Sem a
# `cpf_key`, todo CPF digitado é descartado.
ensure_encryption_keys() {
  local oauth cpf db_url
  oauth="$(env_key NUVEMSHOP_OAUTH_ENCRYPTION_KEY)"
  cpf="$(env_key CPF_ENCRYPTION_KEY)"
  db_url="$(./scripts/local-supabase.sh status | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).DB_URL || ""))')"
  [[ -n "$db_url" ]] || { printf 'Erro: Supabase local não retornou DB_URL.\n' >&2; exit 1; }
  # A `cpf_key` nunca é sobrescrita: trocar a chave deixa ilegível todo CPF já
  # cifrado com a anterior (docs/SETUP.md).
  docker run --rm --network host postgres:15-alpine psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '$oauth') on conflict (name) do update set value = excluded.value, updated_at = now();
     insert into private.app_secrets (name, value) values ('cpf_key', '$cpf') on conflict (name) do nothing;" \
    >/dev/null
}

case "${1:-}" in
  up)
    ensure_supabase
    ./scripts/local-env.sh ensure
    require_env
    ensure_encryption_keys
    "${COMPOSE[@]}" up -d --build
    ;;
  down)
    "${COMPOSE[@]}" down
    ./scripts/local-supabase.sh stop || true
    ;;
  restart)
    require_env
    "${COMPOSE[@]}" restart
    ;;
  status)
    require_env
    ./scripts/local-supabase.sh status
    "${COMPOSE[@]}" ps
    ;;
  logs)
    require_env
    "${COMPOSE[@]}" logs -f --tail=200 "${2:-app}"
    ;;
  supabase-status)
    ./scripts/local-supabase.sh status
    ;;
  chaves)
    require_env
    ensure_encryption_keys
    ;;
  reset)
    require_env
    "${COMPOSE[@]}" down
    ./scripts/local-supabase.sh stop
    ./scripts/local-supabase.sh start
    "${COMPOSE[@]}" up -d
    ;;
  *)
    usage
    exit 2
    ;;
esac
