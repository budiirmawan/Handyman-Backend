# CR-HM-DB-OPT-01 — Railway PostgreSQL DBA Runbook

Audience: operators deploying `budiirmawan/Handyman-Backend` on Railway with a
PostgreSQL 16 service. Covers migration ordering, backup/restore
prerequisites, pool sizing, alerts, rollback and revalidation for the
CR-HM-DB-OPT-01 changes. **Nothing in this runbook should be executed against
production without the normal change approval.**

---

## 1. Topology and networking

- Application runtime MUST connect over Railway's **private** `DATABASE_URL`
  (same-environment traffic). Never use `DATABASE_PUBLIC_URL` for the app —
  the public endpoint is for operator tooling only (psql from a laptop).
- The app accepts either:
  - `DATABASE_URL` (postgres:// or postgresql:// URI, `sslmode` honored), or
  - the legacy `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` /
    `DB_SSL` variables — these override the URL field-by-field when set.
- Migrations run as an explicit one-shot job (`node dist/database/cli.js
  migrate`); the server never auto-migrates. Prefer a **direct/unpooled**
  session for migrations (see §5).

## 2. Backup / restore prerequisites (before any schema change)

1. Trigger a Railway Postgres backup snapshot (or `pg_dump -Fc` from the
   private URL) BEFORE running migrations.
2. Verify the snapshot restores into a scratch database (spot-check
   `schema_migrations`, `handyman_service_requests`, `authentication_audit_events`
   counts).
3. Record `SELECT max(id) FROM schema_migrations` and
   `SELECT count(*) FROM pg_index WHERE NOT indisvalid` before/after.

## 3. Migration ordering

- Chain is strictly ordered by the `migrations` registry
  (`src/database/migrations/index.ts`); `schema_migrations` records applied
  IDs. Current chain: `0001_initial_foundation` … `0433_handyman_customer_payment_proof`,
  `0434_handyman_db_opt_indexes`.
- `0434` is **non-transactional** (`transactional: false`) because it uses
  `CREATE INDEX CONCURRENTLY`. The runner executes it outside any transaction
  block and refuses to record it as applied if any of its indexes is left
  `indisvalid = false`.
- If a CONCURRENTLY build fails midway it leaves an INVALID index and the
  migration is NOT recorded. Cleanup before retry:
  ```sql
  SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE NOT i.indisvalid;
  -- for each invalid index:
  DROP INDEX CONCURRENTLY IF EXISTS <name>;
  -- then re-run: node dist/database/cli.js migrate
  ```
- Order for production: backup → migrate (one-shot job) → verify (§7) →
  deploy the new app image (pool config). Schema-first is safe: the new
  indexes are purely additive and the old app binary ignores them.

## 4. Pool sizing and timeouts (env vars)

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `DB_POOL_MAX` | 10 | 1–100 | Max pooled server connections per process |
| `DB_POOL_MIN` | 0 | 0–100 (≤ MAX) | Warm idle connections kept open |
| `DB_CONNECTION_TIMEOUT_MS` | 5000 | 100–120000 | Max wait for a pool checkout |
| `DB_IDLE_TIMEOUT_MS` | 30000 | 1000–600000 | Idle client eviction |
| `DB_STATEMENT_TIMEOUT_MS` | 0 (disabled) | 0–3600000 | Server-side `statement_timeout` |
| `DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | 0 (disabled) | 0–3600000 | Kills leaked idle-in-transaction sessions |
| `DATABASE_URL` | — | — | Railway private URI (base config) |

Sizing guidance: keep `DB_POOL_MAX` well under
`max_connections` / (number of app replicas). Railway's Postgres plans have
modest `max_connections` (typically ~100 on entry tiers) and PgBouncer sits in
front on some plans — count every replica's pool. Example: 3 replicas × 10 =
30 app connections, leaving headroom for migrations, psql and the platform.

Recommended production opt-ins (validated in staging first):

```
DB_STATEMENT_TIMEOUT_MS=30000
DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS=60000
```

Note: `statement_timeout` applies to pooled sessions INCLUDING the migration
job's pool; the migration runner disables it for the duration of each
migration, so one-shot migrations are safe even with the variable set.

## 5. Migrations on Railway

```
# one-shot job / shell, direct to the DB (NOT through transaction pooling):
DATABASE_URL=<private-url> node dist/database/cli.js migrate
DATABASE_URL=<private-url> node dist/database/cli.js status
```

- Keep migrations on a direct session (or PgBouncer session mode): the runner
  uses short transactions and, for `0434`, statements that cannot run inside a
  transaction block.
- `down` exists per migration; several historical `down`s are frozen by design
  (e.g. `0369_create_saas_payments`) and will refuse to revert — rollback is
  restore-from-backup for those.

## 6. PgBouncer evaluation (optional feature — currently NOT enabled)

Assessed constraints from the codebase:

- **Session-level advisory locks** (`pg_advisory_lock`/`pg_advisory_unlock`) in
  `utility-ocr-candidate.service.ts` — incompatible with transaction pooling
  (locks must span several statements on the same server session).
- Transaction-scoped `pg_advisory_xact_lock` (configuration-version
  activation, platform-support sessions) is transaction-pooling-safe.
- `FOR UPDATE … SKIP LOCKED` queue claims are safe under transaction pooling
  (locks live inside the claim transaction).
- node-postgres uses unnamed prepared statements by default → safe; explicitly
  named prepared statements would need `statement_cache_size=0`-style handling.
- Migrations require a direct/unpooled session (see §5).

Conclusion: adopt Railway managed PgBouncer **only** when server-connection
pressure actually approaches `max_connections` AND the session-advisory-lock
usage has been migrated to transaction-scoped locks or pinned server sessions.
Until then, direct connections with bounded pools (§4) are the supported mode.

## 7. Post-migration verification

```sql
SELECT c.relname, i.indisvalid
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN (
   'handyman_service_requests_client_created_idx',
   'handyman_visit_appointments_request_created_idx',
   'handyman_es_assignments_scope_assigned_idx',
   'handyman_arrival_results_scope_evaluated_idx',
   'handyman_service_warranty_claims_scope_created_idx',
   'authentication_audit_events_created_at_id_idx',
   'authentication_audit_events_user_created_at_id_idx');
-- expect 7 rows, all indisvalid = true

SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 3;
-- expect 0434_handyman_db_opt_indexes at the top
```

API revalidation (staging, same contracts as before):
`GET /api/v1/handyman/operations-queue`, audit list with/without `userId`,
one status-visibility read, one appointment list. Response shapes and
authorization results must be byte-compatible.

## 8. Metrics and alerts

| Signal | Source | Alert |
| --- | --- | --- |
| Connection saturation | `pg_stat_activity` count by `application_name='asentra-backend'` vs `max_connections` | > 70% for 5 min |
| Long queries | `pg_stat_activity.state='active' AND now()-query_start > interval '60 s'` | any row |
| Idle-in-transaction | `state='idle in transaction'` older than 5 min | any row |
| Invalid indexes | `pg_index WHERE NOT indisvalid` | any row |
| Failed migrations | `schema_migrations` missing expected head after job | job failure |
| Pool wait latency | app logs / `DB_CONNECTION_TIMEOUT` errors | any spike |
| Table growth | `pg_stat_user_tables.n_live_tup` on `authentication_audit_events`, `handyman_service_requests` | capacity planning |

`pg_stat_statements` is optional; enable via Railway parameter groups if
available and sample top-N by `total_exec_time` weekly.

## 9. Rollback

- **App config:** revert env vars (defaults equal the pre-CR hard-coded
  values; no schema dependency).
- **Indexes (0434):** additive; rolling back the binary does not require
  dropping them. If an index must be removed:
  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS handyman_service_requests_client_created_idx;
  -- …repeat for each index in 0434 (see migration header)
  ```
  then `node dist/database/cli.js down` once (reverts 0434 bookkeeping) or
  delete the `0434_…` history row after manual drops.
- **Data:** restore from the §2 snapshot. Never delete/truncate financial,
  audit or evidence rows to "fix" schema issues.

## 10. Optional index cleanup (SEPARATE approval required — NOT part of 0434)

The overlap audit found 36 same-column index pairs where a plain index
duplicates a unique index (see audit report §4.2), e.g.
`work_orders_request_idx`, `handyman_quotation_versions_thread_idx`,
`bast_documents_document_idx`, `service_catalog_client_code_idx`,
`document_versions_document_idx`, `handyman_service_requests_attribution_idx`.
After 0434 is applied, `authentication_audit_events_created_at_idx` and
`authentication_audit_events_user_id_idx` also become prefix-redundant.

Each drop must be individually verified (direction-sensitive pairs included),
approved, and executed as `DROP INDEX CONCURRENTLY` in its own change window
with `pg_stat_user_indexes.idx_scan` evidence (zero scans over ≥14 days) —
out of scope for CR-HM-DB-OPT-01.

## 11. Benchmark reproduction

`scripts/db-bench/README.md` — synthetic fixture benchmark against a scratch
PostgreSQL 16 (`asentra_bench`, auto-dropped). Never point it at a real
database; it drops and recreates `asentra_bench` only.
