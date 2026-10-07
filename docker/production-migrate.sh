#!/bin/sh
# =============================================================================
# HANDYMAN DEPLOY D01 — production migration runner
#
# Applies every pending versioned migration against the configured PostgreSQL
# database, then applies the idempotent RBAC bootstrap seeds.
#
# This runner holds NO business logic and defines NO SQL of its own. It only
# sequences the backend's existing, tested entrypoints through the compiled CLI
# (dist/database/cli.js, built from src/database/cli.ts):
#
#   status  -> used purely as a database readiness probe
#   migrate -> applies pending migrations, each in its own transaction
#   seed    -> applies idempotent bootstrap data (permission codes and the
#              PLATFORM_ADMIN role); it never seeds users, credentials, or
#              passwords, and is safe to re-run on every deploy
#
# Intended to run as a dedicated one-shot container, as the image's non-root
# `node` user:
#
#   docker run --rm --env-file <env-file> handyman-backend:<tag> \
#     ./docker/production-migrate.sh
#
# Configuration comes from the environment (NODE_ENV=production is baked into
# the image, so src/config/env.ts reads no .env file and every DB_* variable
# must be supplied by the platform).
#
# Optional tunables:
#   MIGRATE_WAIT_FOR_DATABASE   default: true   bounded wait for PostgreSQL
#   MIGRATE_WAIT_ATTEMPTS       default: 20     readiness probe attempts
#   MIGRATE_WAIT_DELAY_SECONDS  default: 3      delay between probes
#   MIGRATE_SEED                default: true   run bootstrap seeds after migrate
# =============================================================================

set -eu

APP_DIR="${APP_DIR:-/app}"
CLI="dist/database/cli.js"

WAIT_FOR_DATABASE="${MIGRATE_WAIT_FOR_DATABASE:-true}"
WAIT_ATTEMPTS="${MIGRATE_WAIT_ATTEMPTS:-20}"
WAIT_DELAY_SECONDS="${MIGRATE_WAIT_DELAY_SECONDS:-3}"
RUN_SEEDS="${MIGRATE_SEED:-true}"

log() {
    printf 'production-migrate: %s\n' "$1"
}

cd "$APP_DIR"

if [ ! -f "$CLI" ]; then
    log "FATAL: $APP_DIR/$CLI not found — image was not built correctly" >&2
    exit 1
fi

# `status` opens a real connection through the backend's own connection
# boundary and exits non-zero when PostgreSQL is unreachable, which makes it a
# truthful readiness probe without adding any client tooling to the image.
if [ "$WAIT_FOR_DATABASE" = "true" ]; then
    attempt=1
    until node "$CLI" status >/dev/null 2>&1; do
        if [ "$attempt" -ge "$WAIT_ATTEMPTS" ]; then
            log "FATAL: database not reachable after $WAIT_ATTEMPTS attempt(s)" >&2
            exit 1
        fi

        log "waiting for database (attempt $attempt of $WAIT_ATTEMPTS)"
        attempt=$((attempt + 1))
        sleep "$WAIT_DELAY_SECONDS"
    done
fi

log "applying pending migrations"
node "$CLI" migrate

if [ "$RUN_SEEDS" = "true" ]; then
    log "applying idempotent bootstrap seeds"
    node "$CLI" seed
fi

log "completed"
