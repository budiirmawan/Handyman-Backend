# Handyman Backend — production image (Node 22, dist-only runtime).
#
# LAYOUT
#   deps   — production node_modules (npm ci --omit=dev; src/ imports zero
#            devDependencies, so the runtime never needs the build toolchain).
#   build  — full install + `npm run build` (tsc) producing ./dist.
#   runner — dist + production node_modules only, executed as the non-root
#            `node` user. No source, no tests, no secrets, no .env baked in
#            (config .env loading is skipped when NODE_ENV=production).
#
# MIGRATIONS ARE EXPLICIT — the server never auto-migrates or auto-seeds.
# Run the compiled migration runner as a separate one-shot step:
#   docker run --rm --env-file <env> <image> node dist/database/cli.js migrate
# (equivalently: `npm run db:migrate:prod` — package.json ships for this.)
# `status` is available the same way (…/cli.js status). `down`/`seed` stay
# operator-only and are never wired into boot.
#
# EVIDENCE — local-disk driver only. The writable directory is created and
# chowned to the runtime user here; EVIDENCE_STORAGE_DIR pins the absolute
# path so it never depends on the working directory. Mount a volume over it
# to persist evidence beyond the container lifetime.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/.data/evidence && chown -R node:node /app/.data
ENV EVIDENCE_STORAGE_DIR=/app/.data/evidence
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
