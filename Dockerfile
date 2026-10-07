# =============================================================================
# Handyman Backend - production image (multi-stage)
#
#   base       node:<NODE_VERSION>-bookworm-slim (Node >= 20, see package.json "engines")
#   build      full toolchain: `npm ci` + `npm run build` -> /app/dist      (discarded)
#   prod-deps  production-only dependencies -> /app/node_modules            (discarded)
#   runtime    dist + production node_modules only; non-root; port 3000     (shipped)
#
# Build:
#   docker build -t handyman-backend .
#
# Run (default CMD is `node dist/server.js`):
#   docker run -p 3000:3000 --env-file <file kept OUTSIDE the repo> handyman-backend
#
# Secrets / configuration are NEVER baked into the image. Provide every setting
# (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, CORS_ORIGINS, provider
# credentials, ...) when the container starts: --env / --env-file / an
# orchestrator secret store. NODE_ENV=production also makes the app ignore .env.
#
# Migrations are production-safe and never implicit:
#   * They run the COMPILED CLI (dist/database/cli.js) with plain node - no tsx,
#     no devDependencies. Only forward `migrate` is exposed by the entrypoint;
#     `down` and `seed` are never run automatically.
#   * One-shot job (recommended; required with more than one replica):
#       docker run --rm --env-file <file> handyman-backend migrate
#   * Opt-in on boot (single instance only): -e MIGRATE_ON_START=true
#   * Seeds are an explicit operator action and are never auto-run.
#
# Type-check policy of the build stage: STRICT by default (any tsc error fails the
# build). `--build-arg ALLOW_TYPE_ERRORS=true` opts in to emitting anyway; see below.
# =============================================================================

ARG NODE_VERSION=22

# -----------------------------------------------------------------------------
# base: shared Node image + working directory
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app

# -----------------------------------------------------------------------------
# build: compile TypeScript (src/ -> dist/)
# -----------------------------------------------------------------------------
FROM base AS build

# Lockfile-exact install of ALL dependencies (typescript and @types/* are devDependencies).
#   --ignore-scripts  no dependency lifecycle script runs as root during the build
#                     (none is needed to compile).
#   --engine-strict   fail fast if Node does not satisfy package.json "engines" (>=20),
#                     e.g. an unsuitable --build-arg NODE_VERSION.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --engine-strict --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

# Compile with the project's own `build` script (tsc).
#   Strict by default: ANY tsc failure fails the image build.
#   --build-arg ALLOW_TYPE_ERRORS=true accepts exactly one outcome: tsc exit code 2
#   ("diagnostics reported, JS still emitted"). Every other failure stays fatal. Types
#   are erased at emit time, so the emitted JS is the same either way; the switch only
#   decides whether outstanding type diagnostics block the build.
#   NODE_OPTIONS: tsc needs ~1.2 GiB for this codebase, more than V8's default heap
#   cap on small CI builders.
#   Finally assert the artifacts the runtime contract depends on (server + migration CLI).
ARG ALLOW_TYPE_ERRORS=false
RUN set -eu; \
    status=0; \
    NODE_OPTIONS=--max-old-space-size=2048 npm run build || status=$?; \
    if [ "$status" -ne 0 ]; then \
      if [ "$status" -eq 2 ] && [ "$ALLOW_TYPE_ERRORS" = "true" ]; then \
        echo "WARNING: tsc reported type errors (exit 2) but emitted JS; continuing because ALLOW_TYPE_ERRORS=true." >&2; \
      else \
        echo "ERROR: 'npm run build' failed with exit code $status (tsc exit 2 = type errors; opt in to emit anyway with --build-arg ALLOW_TYPE_ERRORS=true)." >&2; \
        exit "$status"; \
      fi; \
    fi; \
    for artifact in dist/server.js dist/database/cli.js; do \
      [ -f "$artifact" ] || { echo "ERROR: build did not produce $artifact" >&2; exit 1; }; \
    done

# -----------------------------------------------------------------------------
# prod-deps: production-only node_modules (no typescript, tsx, test tooling)
# -----------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund

# -----------------------------------------------------------------------------
# runtime: what actually ships
# -----------------------------------------------------------------------------
FROM base AS runtime

# Non-secret defaults only. NODE_ENV is set here (not in `base`) so the build stage
# still installs devDependencies.
ENV NODE_ENV=production \
    PORT=3000

# Entrypoint (own file name: the base image already ships its own docker-entrypoint.sh).
# Normalise line endings (a Windows checkout may have CRLF) and make it executable.
# Local evidence storage writes to ./.data/evidence (cwd /app): pre-create it owned by
# the runtime user so a non-root process can write there; mount a volume at
# /app/.data/evidence to persist files. Everything else under /app stays root-owned and
# therefore read-only for the runtime user.
COPY docker/entrypoint.sh /usr/local/bin/handyman-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/handyman-entrypoint.sh \
    && chmod 0755 /usr/local/bin/handyman-entrypoint.sh \
    && mkdir -p /app/.data/evidence \
    && chown -R 1000:1000 /app/.data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Non-root. Numeric on purpose (orchestrators can verify runAsNonRoot only for numeric
# users); 1000:1000 is the base image's built-in `node` user.
USER 1000:1000

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/handyman-entrypoint.sh"]
CMD ["node", "dist/server.js"]
