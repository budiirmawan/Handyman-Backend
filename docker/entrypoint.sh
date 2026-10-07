#!/bin/sh
# Handyman Backend - container entrypoint (production image).
#
# Does exactly three things:
#   1. `migrate`          one-shot, forward-only schema migration, then exit.
#   2. MIGRATE_ON_START   opt-in: run the same migration before booting the server.
#   3. anything else      exec as-is (default CMD: node dist/server.js).
#
# Production-safety rules enforced here:
#   * Migrations run the COMPILED CLI (dist/database/cli.js) with plain `node`;
#     the tsx / devDependency toolchain does not exist in this image.
#   * Only the forward `migrate` command is ever invoked. `down` (rollback) and
#     `seed` are never run by this script - not on boot, not via `migrate`.
#   * Migrations never run implicitly: the default is OFF.
#   * A failed migration is fatal: the script exits non-zero and the server is
#     NOT started, so the app never serves traffic from a half-migrated schema.
#   * `exec` hands PID 1 to node so SIGTERM/SIGINT reach the app's own graceful
#     shutdown handlers.
#
# The migration runner has no cross-process lock. Use the one-shot `migrate` job
# (or a single instance with MIGRATE_ON_START=true), never several replicas
# racing to migrate at once.
set -eu

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

# 1. One-shot migration job: `docker run --rm <env> <image> migrate`
if [ "${1:-}" = 'migrate' ]; then
  if [ "$#" -ne 1 ]; then
    log 'usage: migrate (takes no arguments; rollback and seed are never run by this entrypoint)'
    exit 64
  fi
  log 'applying pending database migrations (forward-only)'
  exec node dist/database/cli.js migrate
fi

# 2. Opt-in migration before booting the server (default server command only).
if [ "${1:-}" = 'node' ] && [ "${2:-}" = 'dist/server.js' ]; then
  case "$(printf '%s' "${MIGRATE_ON_START:-false}" | tr '[:upper:]' '[:lower:]')" in
    true | 1)
      log 'MIGRATE_ON_START is enabled: applying pending database migrations (forward-only)'
      node dist/database/cli.js migrate
      ;;
    false | 0) ;;
    *)
      log "MIGRATE_ON_START must be true or false (received '${MIGRATE_ON_START}')"
      exit 64
      ;;
  esac
fi

# 3. Hand over to the requested command (PID 1 becomes the command itself).
exec "$@"
