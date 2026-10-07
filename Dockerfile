# syntax=docker/dockerfile:1

# =============================================================================
# HANDYMAN DEPLOY D01 — production container image (multi-stage)
#
#   deps    : install the full dependency tree (devDependencies provide tsc)
#   build   : compile src/ -> dist/ with the repository's own build script
#   runtime : production dependencies + compiled JS only, non-root, port 3000
#
# Build:
#   docker build -t handyman-backend:<tag> .
#
# Serve:
#   docker run --rm -p 3000:3000 --env-file <env-file> handyman-backend:<tag>
#
# Apply migrations (dedicated one-shot run, before/alongside first boot):
#   docker run --rm --env-file <env-file> handyman-backend:<tag> \
#     ./docker/production-migrate.sh
#
# Scope: container packaging only. No compose, no MinIO/S3, and no business
# logic is introduced or changed by this file.
# =============================================================================

ARG NODE_VERSION=20

# -----------------------------------------------------------------------------
# Stage 1: dependencies
# Full tree, because the build stage needs typescript + @types/* (devDeps).
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Manifests are copied first so the dependency layer is cached independently
# of source changes.
COPY package.json package-lock.json ./

# --ignore-scripts skips npm lifecycle scripts. The only script-running package
# in this tree is the test-only `embedded-postgres` devDependency, whose
# postinstall downloads a PostgreSQL binary; it is not needed to compile.
RUN npm ci --ignore-scripts

# -----------------------------------------------------------------------------
# Stage 2: build
# TypeScript -> JavaScript via the repository's own `npm run build` (tsc).
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Strict and unforgiving: tsc exits non-zero on any type error, so a broken
# source tree cannot produce a shippable image. `dist/` is the only artifact.
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: runtime
# Production dependencies plus compiled output. No TypeScript, no devDeps,
# no sources, no repository tooling.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# NODE_ENV=production: src/config/env.ts never reads a .env file in production,
# so all configuration must arrive from the real environment (secrets manager,
# orchestrator env, etc.).
# PORT=3000: the documented backend port; src/server.ts binds 0.0.0.0:${PORT}.
ENV NODE_ENV=production \
    PORT=3000 \
    API_PREFIX=/api/v1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Production dependency tree only. No production dependency in this repository
# declares an install/postinstall script, so --ignore-scripts is a no-op for
# behaviour and removes an untrusted-code execution surface at build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Compiled application + the production migration runner.
COPY --from=build /app/dist ./dist
COPY docker/production-migrate.sh ./docker/production-migrate.sh

# Writable local evidence directory.
#
# The only filesystem write path in src/ is the local evidence storage backend
# (src/modules/evidence/storage/local-evidence-storage.ts), rooted at
# `EVIDENCE_STORAGE_DIR` — default `.data/evidence`, resolved against the
# process working directory (DEFAULTS.storage.dir in src/config/env.ts).
# Request handlers create `evidence/<uuid>` and `reports/<uuid>` files there at
# runtime, so the directory must pre-exist and be owned by the non-root user.
RUN chmod 0755 docker/production-migrate.sh \
    && mkdir -p .data/evidence \
    && chown -R node:node .data \
    && chmod 0750 .data .data/evidence

# Unprivileged runtime user (uid 1000) shipped by the official Node image.
USER node

EXPOSE 3000

# Liveness probe against the backend's own health endpoint, mounted under
# API_PREFIX by src/routes/health.routes.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}${API_PREFIX}/health" || exit 1

# exec form: node is PID 1, so SIGTERM/SIGINT reach the graceful shutdown
# handler in src/server.ts without an intervening shell.
CMD ["node", "dist/server.js"]
