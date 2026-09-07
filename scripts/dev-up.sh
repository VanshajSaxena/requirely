#!/usr/bin/env bash
# Brings up local Postgres and applies migrations, or says exactly why it could not.
#
# The CLI already self-migrates — `apps/cli/src/compose.ts` calls
# `connection.migrate()` on every Postgres command — so this script is not
# load-bearing for correctness. It exists so a failure surfaces during *setup*,
# where the remedy is obvious, rather than inside a user's first real command,
# where it arrives wrapped in whatever they were actually trying to do.
#
# Same rule as the boundary scripts: abort loudly rather than pass vacuously. A
# setup script that prints "ready" without a reachable database is worse than no
# script at all, because the next failure gets blamed on the application.
set -uo pipefail
cd "$(dirname "$0")/.."

RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -h|--help)
      printf 'usage: scripts/dev-up.sh [--reset]\n\n'
      printf '  --reset   destroy the volume and start from an empty database\n'
      exit 0 ;;
    *) printf 'dev-up: unknown argument %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

die() { printf '\n  \342\234\227 %s\n' "$1" >&2; shift; [ $# -gt 0 ] && printf '%s\n' "$@" | sed 's/^/      /' >&2; exit 1; }
ok()  { printf '  \342\234\223 %s\n' "$1"; }

# A wrong cwd must fail here, not three commands later against someone else's
# docker-compose.yml.
[ -f docker-compose.yml ] && [ -f package.json ] || \
  die "no docker-compose.yml and package.json under $PWD" "dev-up.sh must run from the repo root."

# ------------------------------------------------------------------ the daemon
command -v docker >/dev/null 2>&1 || die "docker is not on PATH"

if ! DOCKER_ERR=$(docker info 2>&1 >/dev/null); then
  case "$DOCKER_ERR" in
    *"permission denied"*|*"Got permission denied"*)
      die "the docker daemon is running but this shell cannot reach its socket" \
          "Your user is not in the 'docker' group *in this shell*. If the group is" \
          "already in your system configuration, activate it here without logging out:" \
          "" \
          "    newgrp docker" \
          "" \
          "then run this script again. Group membership is granted at login, so a" \
          "config change alone does not affect a shell that was already open." ;;
    *)
      die "cannot reach the docker daemon" "$DOCKER_ERR" ;;
  esac
fi
ok "docker daemon reachable"

# ------------------------------------------------------------------- the server
if [ "$RESET" -eq 1 ]; then
  printf '  … --reset: destroying the volume\n'
  docker compose down -v >/dev/null 2>&1 || die "docker compose down -v failed"
  ok "volume destroyed"
fi

# The host port this compose file will publish on. Read from .env the same way
# `docker compose` itself reads it, so the check and the bind can never disagree.
PORT=$(sed -n 's/^REQUIRELY_DB_PORT=\([0-9][0-9]*\).*/\1/p' .env 2>/dev/null | tail -1)
PORT=${PORT:-5432}

# Pre-flight, because the raw failure is genuinely misleading: docker reports
# "failed to bind host port 0.0.0.0:5432/tcp: address already in use", which
# reads like a docker problem and is actually a native Postgres holding the port.
# Measured on this repo's first real machine: a NixOS postgresql service bound to
# 127.0.0.1:5432, with no `requirely` role, so BOTH candidates for the port were
# unusable and neither said so.
if ss -ltn 2>/dev/null | grep -q "[:.]${PORT}[[:space:]]"; then
  if [ "$(docker compose ps -q postgres 2>/dev/null)" = "" ]; then
    die "host port ${PORT} is already in use by something that is not our container" \
        "Most often that is a Postgres already running as a system service." \
        "Check with:  ss -ltnp | grep ${PORT}" \
        "" \
        "Do not stop it — point this project somewhere else instead. In .env set" \
        "a free port in BOTH places, then re-run:" \
        "" \
        "    REQUIRELY_DB_PORT=5433" \
        "    DATABASE_URL=postgres://requirely:requirely@localhost:5433/requirely"
  fi
fi

# Captured once. An earlier version built its error message with
# "$(docker compose up -d ...)", which RE-RUNS the command — so the text shown
# described a different attempt than the one that failed, and on a port conflict
# it printed a successful-looking "Started". A diagnostic must not have side
# effects.
if ! UP_OUT=$(docker compose up -d 2>&1); then
  die "docker compose up -d failed" "$UP_OUT"
fi
ok "container up on host port ${PORT}"

# Polling pg_isready rather than sleeping: a fixed sleep is either too short on a
# cold volume (first start initialises the cluster) or wasted on every run after.
printf '  … waiting for Postgres to accept connections'
for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U requirely -d requirely >/dev/null 2>&1; then
    printf '\r'; ok "Postgres accepting connections            "
    READY=1; break
  fi
  printf '.'; sleep 1
done
[ "${READY:-0}" -eq 1 ] || { printf '\n'; die "Postgres did not become ready within 60s" \
  "$(docker compose logs --tail 20 postgres 2>&1)"; }

# ---------------------------------------------------------------- the migrations
pnpm db:migrate >/dev/null 2>&1 || die "migrations failed" "$(pnpm db:migrate 2>&1 | tail -20)"
ok "migrations applied"

printf '\nReady. Next:\n'
printf '  ./bin/requirely new --title "My product"\n'
printf '  ./bin/requirely add <id> ./notes.md\n'
printf '  ./bin/requirely turn <id>\n\n'
printf 'No spend? Add --script apps/cli/fixtures/roomly.json to every command.\n'
