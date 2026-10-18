# Handyman deployment environment matrix

CR-HM-DEPLOY-PORTABILITY-01 · audited 2026-10-17 · Backend only.
Canonical parsing: `src/config/env.ts`; artifact: `Dockerfile` (Node 22,
CommonJS ES2022 output from TypeScript 5.9). `.env.example` contains placeholders,
not deployable credentials. Production deliberately does **not** load `.env`.
Inject variables into the process through Railway/Coolify; an operator-only
`docker --env-file` injects them, unlike copying a `.env` into the image.

## Stage 1 and Phase 2 mapping

| Actual variable | Default / validation | Railway | Biznet / Coolify |
|---|---|---|---|
| `NODE_ENV` | development; development/test/production | **production** | **production** |
| `PORT` | 3000, 1–65535 | platform port or explicit 3000; match target port | 3000; proxy target 3000 |
| `API_PREFIX` | `/api/v1`, path | retain `/api/v1` | same |
| `LOG_LEVEL` | info; error/warn/info/debug | info, JSON stderr | info, JSON stderr with rotation |
| `DB_HOST` | localhost; nonempty if supplied | reference PostgreSQL **private** hostname | private Docker service hostname |
| `DB_PORT` | 5432; 1–65535 | reference database's internal port | 5432 internal, not published |
| `DB_NAME` | asentra (test: asentra_test) | explicit provisioned database | restored/provisioned database |
| `DB_USER` | postgres | dedicated runtime role, not owner | dedicated runtime role |
| `DB_PASSWORD` | empty | runtime-role secret | rotated/new runtime-role secret |
| `DB_SSL` | false; true/false/1/0 | decide from actual network/certificate requirements | same, based on transport |
| `CORS_ORIGINS` | production: **empty** (no browser origins); comma-separated exact HTTP(S) origins; no wildcard | `https://handyman-frontend-alpha.vercel.app` | identical Vercel origin |
| `EVIDENCE_STORAGE_DRIVER` | local; only local accepted | local | local |
| `EVIDENCE_STORAGE_DIR` | `.data/evidence`; Docker pins `/app/.data/evidence` | `/app/.data/evidence` with Railway Volume at that exact mount | same container path backed by persistent bind/named volume |
| `SCHEDULER_ENABLED` | true in production; false in development; always false in test | false while provisioning; true only for the sole approved active instance | false on migration target; true only after exclusive activation |
| `SCHEDULER_INTERVAL_MS` | 60000; integer ≥1000 | 60000 | same |
| `JSON_BODY_LIMIT` | 1mb; integer b/kb/mb | 1mb | same |
| `SESSION_TTL_MINUTES` | 480; integer ≥1 | 480 unless security policy changes | preserve policy |
| `SESSION_TOKEN_BYTES` | 32; integer ≥16 | 32 | same |
| `SESSION_LAST_USED_THROTTLE_MS` | 300000; integer ≥0 | 300000 | same |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES` | 15; integer ≥1 | 15 | same |
| `AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS` | 10; integer ≥1 | 10 | same |
| `INVITATION_TTL_HOURS` | 72; integer ≥1 | 72 | same |
| `EMAIL_PROVIDER` | noop (provider config validated by selected adapter) | noop for presentation unless delivery separately approved | preserve approved provider |
| `WHATSAPP_PROVIDER` | noop | noop unless separately configured | same |
| `PUSH_PROVIDER` | noop | noop unless separately configured | same |

**Explicit DB variables are an operational requirement**, even though the
parser retains local development defaults. Empty/malformed fields fail parsing;
a valid-looking wrong configuration fails the bounded startup connection check.
Do not rely on the defaults to provision a database.

## Names that are NOT Backend settings

- `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` are
  **not** consumed by this application's config. PostgreSQL CLI tools use the
  `PG*` names separately. Map Railway-provided connection fields explicitly to
  the six `DB_*` variables above. Never print a connection URL.
- `MIGRATION_DATABASE_URL` / `MIGRATION_DB_*` do not exist. The one-shot runner
  uses the **same** `DB_*` names in a separate process with migration credentials.
  Do not replace the long-lived API's runtime credentials with an owner secret.
- No `SESSION_SECRET`, `JWT_SECRET`, `PUBLIC_API_ORIGIN`, `API_URL`, `TRUST_PROXY`,
  `S3_BUCKET` or object storage setting is required/implemented for Stage 1.
  Sessions are opaque random bearer tokens; SHA-256 token hashes live in
  `user_sessions`. There are no browser session cookies or JWT signing secrets
  for this flow. Do not invent such variables.
- `DB_PASSWORD` in Compose is caller-supplied and mandatory. Compose defaults to
  the provisioning postgres role for local use; use reviewed runtime-role
  overrides in Coolify, not that local owner setup unchanged in production.

## TLS, CORS and reverse proxy

`DB_SSL=true` uses `{rejectUnauthorized: true}`. Install a valid CA chain (Node's
`NODE_EXTRA_CA_CERTS=/path/to/mounted-ca.pem` if required) and verify hostname and
certificate. Never switch certificate verification off. False is acceptable only
on an explicitly approved private transport; do not assume all Railway database
endpoints use identical TLS behavior. Public backup connections may need
`PGSSLMODE=verify-full` and a trusted `PGSSLROOTCERT` independently of API config.

Browser requests use `Authorization: Bearer <sessionToken>`, JSON or multipart
content, optionally `X-Request-ID` and, on the duplicate-risky command routes,
`Idempotency-Key`. CORS allows Content-Type, Authorization, X-Request-ID and
Idempotency-Key; exposes X-Request-ID; credentials are **false**. `If-Match`
is not allowed: no registered route reads an `If-Match` precondition.

CR-HM-BE-CORS-PRODUCTION-01 confirms the production Vercel origin as
`https://handyman-frontend-alpha.vercel.app`, so the Railway/Biznet value is
exactly:

```
CORS_ORIGINS=https://handyman-frontend-alpha.vercel.app
```

The allowlist is exact: a wildcard (`*` or `https://*.vercel.app`), a path, a
query, a fragment or embedded credentials are rejected at configuration time,
and `Access-Control-Allow-Origin: *` can never be produced. Do not wildcard
Vercel previews — a preview host is a different origin and is refused. An
unlisted Origin lacks allow-origin headers; CORS is not authentication. The
operator handoff, including the reproducible HTTPS preflight command, is
`docs/CR-HM-BE-CORS-PRODUCTION-01_CORS_DEPLOYMENT_HANDOFF.md`.

Use stable `https://<api-domain>` through either proxy. Domain is a platform/DNS
setting, not a Backend variable. The Vercel owner must verify their existing API
configuration name; this repository cannot establish it. No Frontend settings
are modified here. Login throttling is process-local and uses the socket peer,
not untrusted forwarded headers: behind a proxy users can share the same throttle
bucket. Verify login capacity for the presentation; do not enable blind proxy
trust or weaken authentication. One replica is required for this rollout.

## Optional integrations

This matrix is the complete central `AppConfig` environment surface for Stage 1,
not a claim to list every optional integration secret in the repository.
Handoff/SMTP/WhatsApp/FCM/webhook adapters have separate configuration boundaries
and dedicated guides. They are not enabled by this change. Do not copy secrets
from a different environment or enable BM Stage 2 to make Stage 1 work.
