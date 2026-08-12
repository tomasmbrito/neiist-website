#!/usr/bin/env bash
#
# Preflight for `yarn dev`.
#
# `docker compose up -d` can report success while the database container ends up with no
# published host port — most often because another Postgres (a Homebrew service, a second
# checkout) already holds the port. The container is then running and correct, but the app
# connects to whatever else is listening, and every data-backed page fails at runtime with
# `role "neiist_app_user" does not exist`. Nothing in that message points at a port conflict.
#
# This script turns that silent misconnection into a loud, specific failure before `next dev`
# starts.

set -euo pipefail

COMPOSE_FILE="./docker/docker-compose.yml"
SERVICE="db"
CONTAINER="neiist_db"
PORT="${POSTGRES_PORT:-5432}"

fail() {
  echo "" >&2
  echo "  yarn dev: database preflight failed" >&2
  echo "" >&2
  while IFS= read -r line; do
    echo "  $line" >&2
  done
  echo "" >&2
  exit 1
}

# Who is holding the port? Best-effort: lsof is present on macOS and most Linux installs.
port_holder() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1}' | sort -u | tr '\n' ' '
}

# 1. The container must actually be running.
if ! docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null |
  grep -qx "$SERVICE"; then
  fail <<EOF
The '$SERVICE' container is not running.

Start it and read the error it prints:
  docker compose -f $COMPOSE_FILE up
EOF
fi

# 2. It must have a published host port. This is the case that used to fail silently.
#
# Read NetworkSettings.Ports, not HostConfig.PortBindings: the latter is what compose *asked*
# for and stays populated even when the bind failed. The former is what actually happened, and
# is `{"5432/tcp":[]}` when the port could not be published. `compose port` is no use here
# either — under this failure it prints "invalid IP:0" rather than nothing.
BINDING="$(docker inspect "$CONTAINER" --format \
  '{{with index .NetworkSettings.Ports "5432/tcp"}}{{if .}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}{{end}}' \
  2>/dev/null || true)"
if [ -z "$BINDING" ]; then
  HOLDER="$(port_holder)"
  fail <<EOF
The '$SERVICE' container is running, but its port is NOT published to the host.

The app would connect to whatever else is listening on port $PORT instead of to this
container, and every data-backed page would fail with:
  role "neiist_app_user" does not exist

Something else is already using port $PORT${HOLDER:+ (process: $HOLDER)}.

Check:
  lsof -nP -iTCP:$PORT -sTCP:LISTEN
  docker ps            # our container will show 5432/tcp with no host mapping

Fix it either way:
  brew services stop postgresql@14        # stop the conflicting server, or
  POSTGRES_PORT=5433 yarn dev             # move ours, and set the port in .env too
EOF
fi

# 3. Postgres inside the container must be accepting connections.
if ! docker exec "$CONTAINER" pg_isready -q 2>/dev/null; then
  fail <<EOF
The '$SERVICE' container is up and its port is published ($BINDING), but Postgres inside it is
not accepting connections yet.

If this persists, the container is probably failing to initialise:
  docker logs $CONTAINER
EOF
fi

echo "  database ready on $BINDING"
