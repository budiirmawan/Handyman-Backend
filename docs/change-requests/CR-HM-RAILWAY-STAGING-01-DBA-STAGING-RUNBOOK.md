# CR-HM-RAILWAY-STAGING-01 — Railway DBA Staging Runbook

**Scope:** staging migration/backup/rollback procedure for the DB-OPT-01 indexes (0434) and the CR-HM-MOBILE-ASSIGN-UUID-01 SQL fix. Production stays untouched until the GO/NO-GO matrix in `CR-HM-RAILWAY-STAGING-01-READINESS-REPORT.md` clears.

---

## 1. Deployment topology (verified from repository configuration)

| Item | Value (from repo) | Source |
|---|---|---|
| Service model | Single Railway service; `node dist/server.js` | `railway.json` `deploy.startCommand` |
| Healthcheck | `GET /api/v1/health` (timeout 300 s, restart ON_FAILURE ×5) | `railway.json` |
| Readiness (DB) | `GET /api/v1/health/database` → `database: connected` | `src/routes/health.routes.ts` |
| Image | `node:22-bookworm-slim`, dist-only, non-root `node`, no `.env` baked | `Dockerfile` |
| Node version | 22 (image); `engines.node >= 20` | `Dockerfile`, `package.json` |
| Migrations | **Explicit one-shot**, never auto-run at boot: `node dist/database/cli.js migrate` (= `npm run db:migrate:prod`) | `Dockerfile` header, `package.json` |
| Background work | DueJobScheduler runs **in-process** (self-disabled under `NODE_ENV=test`, drained ≤5 s on SIGTERM before pool close) | `src/server.ts` |
| Evidence storage | `/app/.data/evidence` — mount a volume (`EVIDENCE_STORAGE_DIR`) | `Dockerfile` |

> **Note:** the repository defines no separate worker service. If ops later adds one, add `+1` connection per worker process to the budget in §2.

## 2. Environment & connection budget (fill ops values; never commit secrets)

**Database variables** (set in Railway service settings):
- `DATABASE_URL` = the **private** endpoint (`postgres.railway.internal:5432`). The app never reads `DATABASE_PUBLIC_URL` (verified: `src/config/env.ts`, `tests/config-db-pool.test.ts`).
- SSL: `DB_SSL=true|false` or `?sslmode=` on `DATABASE_URL` (`disable|allow|prefer|require|verify-ca|verify-full`). Private-network traffic typically `disable`/`prefer`; **do not** put the public endpoint in `DATABASE_URL`.
- Pool: `DB_POOL_MAX` (default 10, validated 2–20), `DB_POOL_MIN`, `DB_POOL_IDLE_TIMEOUT_MS=30000`, `DB_POOL_CONNECTION_TIMEOUT_MS=5000`; optional guards `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` (recommend `60000`).

**Connection budget** (PostgreSQL `max_connections` on the Railway plan = `____` ← ops fills):

```
required = replicas × DB_POOL_MAX + 1 (ops/psql headroom) + 1 (migration one-shot)
```

| Replicas | DB_POOL_MAX=10 | DB_POOL_MAX=20 |
|---|---|---|
| 1 | 12 | 22 |
| 2 | 22 | 42 |
| 3 | 32 | 62 |

Keep `required` ≤ 50% of plan `max_connections` for incident headroom. Verify actual `max_connections` on staging: `SHOW max_connections;`.

**PgBouncer: transaction pooling stays DISABLED.** Session-level advisory locks on pinned clients are in use (`utility-ocr-candidate.service.ts`: `pg_advisory_lock`/`unlock`; `mobile-utility-meter-reading-verification.service.ts`). Transaction pooling would break mutual exclusion. Session-mode pooling is a separate evaluation only if connection pressure demands it.

## 3. Backup / restore prerequisites (before any staging migration)

1. **Ledger checkpoint:** `SELECT count(*), max(filename) FROM schema_migrations;` → expect `434, '0434_handyman_db_opt_indexes'` **after** the release migrate (433 before it).
2. **Logical dump** (Railway-side, from an operator shell with private access):
   `pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl -f pre-0434.dump`
   Store outside the DB volume; record byte size + checksum.
3. **Restore drill** (once per release train, into a scratch database):
   `pg_restore --clean --if-exists -d "$SCRATCH_URL" pre-0434.dump` → app boots, `GET /api/v1/health/database` ok.
4. **Index state snapshot** (must be 0 invalid):
   `SELECT count(*) FROM pg_index WHERE NOT indisvalid;`
5. The migration itself is **additive-only** (7 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`) with `down()` = no-op that preserves ledger history — a dump is for the database as a whole, not for 0434 specifically.

## 4. Approved migration procedure — 0434 on staging

**Pre-checks (read-only):**
1. `SELECT count(*) FROM schema_migrations;` → 433 (head `0433_…`).
2. `SELECT indexname FROM pg_indexes WHERE indexname IN (7 names below);` → likely partial/absent; all must be VALID if present (`pg_index.indisvalid`).
3. Confirm with the app stopped or under low traffic (`CREATE INDEX CONCURRENTLY` takes a light lock but builds on live data).

**Execute (one-shot container/job, exactly as the image documents):**
```
node dist/database/cli.js migrate
```
Expected: applies `['0434_handyman_db_opt_indexes']`, ledger → 434.

**Post-checks:**
1. All 7 indexes **VALID**:
   `SELECT indexrelname, indisvalid FROM pg_stat_user_indexes JOIN pg_index …` or simply
   `SELECT count(*) FROM pg_index WHERE NOT indisvalid;` → 0, and
   `SELECT indexname FROM pg_indexes WHERE indexname LIKE '…';` → the 7 names:
   - `handyman_service_requests_client_created_idx`
   - `handyman_visit_appointments_request_created_idx`
   - `handyman_es_assignments_scope_assigned_idx`
   - `handyman_arrival_results_scope_evaluated_idx`
   - `handyman_service_warranty_claims_scope_created_idx`
   - `authentication_audit_events_created_at_id_idx`
   - `authentication_audit_events_user_created_at_id_idx`
2. `SELECT count(*), max(filename) FROM schema_migrations;` → `434, '0434_handyman_db_opt_indexes'`.
3. Smoke: `GET /api/v1/health`, `GET /api/v1/health/database`, `GET /api/v1/mobile/assignments` (authorized) → 200.

**Interrupted build recovery (the migration is self-refusing):**
If the migrate one-shot fails mid-build it prints:
```
Migration failed: CR-HM-DB-OPT-01: index build left INVALID index(es): <name>. Drop them and re-run the migration (see DBA runbook §Rollback).
```
and does **not** record history. Then:
1. `SELECT indexrelname FROM pg_stat_user_indexes WHERE NOT indisvalid;` (or `pg_index WHERE NOT indisvalid`) — identify the named index(es).
2. `DROP INDEX CONCURRENTLY IF EXISTS <name>;` (never a plain `DROP INDEX` on a busy table).
3. Re-run `node dist/database/cli.js migrate` → applies 0434 normally.
Proven live in CR-HM-DB-OPT-02 S2/S3 and pinned by `tests/db-opt-02-migration-recovery.test.ts`.

## 5. Release rollback

**App rollback:** revert the Railway service to the previous image/release. The schema is backward compatible (0434 is additive; the UUID fix is SQL-only).

**Index rollback (safe at any time, no data loss):**
```sql
DROP INDEX CONCURRENTLY IF EXISTS handyman_service_requests_client_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_visit_appointments_request_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_es_assignments_scope_assigned_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_arrival_results_scope_evaluated_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_service_warranty_claims_scope_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS authentication_audit_events_created_at_id_idx;
DROP INDEX CONCURRENTLY IF EXISTS authentication_audit_events_user_created_at_id_idx;
```
0434 then re-applies cleanly on the next migrate (ledger preserved). No table/data/ledger action is ever required.

**Database restore (last resort only):** `pg_restore --clean --if-exists -d "$DATABASE_URL" pre-0434.dump` — accepts downtime; not needed for any failure mode of 0434 or the UUID fix.

## 6. Staging smoke checklist (live — for the operator with Railway access)

1. `GET /api/v1/health` → 200 `status: ok`; `GET /api/v1/health/database` → `database: connected`.
2. Confirm PostgreSQL major = **16**: `SHOW server_version;`.
3. `GET /api/v1/mobile/assignments` with: anonymous (401), wrong-role identity (403), scoped worker empty (200 `[]`), scoped worker with tasks (200, `safetyInspectionBindingId` = id iff exactly one ACTIVE binding), cross-company identity (no foreign items). **No `min(uuid)` / HTTP 500 anywhere.**
4. Key flows: work-order read + lifecycle action on a test work order; `GET /api/v1/handyman/operations/queue?clientId=…` (200); care workspace via `POST /handyman/care/session` + `GET /handyman/care/requests` (care-session contract; ordinary JWT must 401); inspection, appointment, payment, settlement, `GET /api/v1/auth/audit-events` reads (200).
5. Idempotency: repeat a safe read twice (same response); repeat a write on a test entity and confirm the documented idempotent/409 behavior.
6. Plans/utilization (read-only): `EXPLAIN (ANALYZE, BUFFERS)` the Q1/Q2 shapes with a test `clientId`; `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE indexrelname IN (…7 names…);` — all non-zero after traffic.
7. Logs (Railway): no `min(uuid)`, no `connection` leak warnings, no repeated retry storms; graceful shutdown on redeploy (`Shutdown completed` in logs).
8. Metrics (PART 04 of the report): capture API p50/p95 and pool utilization against the staging workload; compare Q1/Q2 to the synthetic baselines **as direction only** (datasets are not comparable).

## 7. Monitoring (first 24 h after staging deploy)

- Healthcheck flap = pool or migration problem → check `SHOW max_connections` vs budget (§2).
- `pg_stat_activity`: `count(*) WHERE state='active'` sustained ≈ pool max = saturation → raise `DB_POOL_MAX` within budget or add replica.
- p95 of `/api/v1/mobile/assignments` and the customer-care queue vs rehearsal baselines (report §measured evidence) — investigate >2× deviations.
- Error log filter: `min(uuid)`, `INTERNAL_SERVER_ERROR`, `could not connect`, `too many connections`.
- Index health weekly: `SELECT count(*) FROM pg_index WHERE NOT indisvalid;` → 0.

## 8. Outstanding risks (accepted / tracked)

1. Live staging values (`max_connections`, replica count, actual p95, PG major string) are **not yet observed** — gates in the readiness report.
2. Five pre-existing stale snapshot/scan tests remain failing by design (tracked test debt — see readiness report §debt); they do not indicate runtime regressions.
3. `tests/handyman-care-workspace-tenants.test.ts` self-collides on re-run against one database (deterministic fixture tokens, no cleanup) — test hygiene debt, not a product defect.
4. Deep-offset pagination remains O(offset) (contract-bound); keyset migration is deferred.
