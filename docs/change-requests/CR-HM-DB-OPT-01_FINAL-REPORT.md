# CR-HM-DB-OPT-01 — Final Delivery Report

Date: 2026-10-13
Branch: `arena/6635d098-handyman-backend`
Base: `edf26c809edf6786c65ebc7edd2a8b0b4f826911` (`main`)

## 1. Migration list

Chain at start: `0001_initial_foundation` … `0433_handyman_customer_payment_proof`
(433 migrations; the CR brief's "0432" historical note was superseded by
`0433` — verified empirically by running the chain).

Added: **`0434_handyman_db_opt_indexes`** (registered last; additive;
`transactional: false`; `CREATE INDEX CONCURRENTLY IF NOT EXISTS` +
post-build `indisvalid` verification; `down` = `DROP INDEX CONCURRENTLY IF
 EXISTS`). No historical migration was edited.

## 2. Exact changed files

| File | Change |
| --- | --- |
| `src/database/migrations/0434_handyman_db_opt_indexes.ts` | **new** — 7 evidence-backed composite indexes (see §3) |
| `src/database/migrations/index.ts` | register 0434 |
| `src/database/migrations/types.ts` | `Migration.transactional?: boolean` (default true — unchanged behavior) |
| `src/database/migrate.ts` | non-transactional migration path; statement-timeout neutralization for migration DDL |
| `src/config/env.ts` | `DatabasePoolSettings`; validated `DB_POOL_MAX/MIN`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`; `DATABASE_URL` (Railway private) parsing with `sslmode` mapping and field-level `DB_*` overrides |
| `src/config/index.ts` | export `DatabasePoolSettings` |
| `src/database/connection.ts` | pool built from validated settings; `statement_timeout`/`idle_in_transaction_session_timeout`; `application_name = 'asentra-backend'` |
| `src/modules/applied-slas/applied-sla.repository.ts` | `findDueRunning` bounded (`ORDER BY started_at, id LIMIT ≤100` via shared `clampDueItemLimit`) |
| `src/modules/handyman-operations-queue/handyman-operations-queue.service.ts` | per-item visibility fan-out resolved in batches of 4 (identical output/order) |
| `tests/config-db-pool.test.ts` | **new** — pool env + DATABASE_URL config tests (18 tests) |
| `tests/db-opt-01-index-migration.test.ts` | **new** — 0434 migration evidence tests (5 tests) |
| `scripts/db-bench/run-bench.ts` | **new** — synthetic fixture benchmark harness |
| `scripts/db-bench/capture-schema.ts` | **new** — schema inventory capture (scratch PG) |
| `scripts/db-bench/gen-table-inventory.ts` | **new** — inventory renderer |
| `scripts/db-bench/README.md`, `scripts/db-bench/out/bench-results.json` | **new** — harness docs + committed measurement evidence |
| `docs/change-requests/CR-HM-DB-OPT-01_AUDIT-REPORT.md` | **new** — PART 00 audit |
| `docs/change-requests/CR-HM-DB-OPT-01_TABLE-INVENTORY.md` | **new** — 423-table inventory appendix |
| `docs/change-requests/CR-HM-DB-OPT-01_RAILWAY-DBA-RUNBOOK.md` | **new** — PART 03.6 runbook |
| `docs/change-requests/CR-HM-DB-OPT-01_FINAL-REPORT.md` | **new** — this report |
| `.gitignore` | **new** — node_modules/dist/.data/bench scratch dirs (repo had none) |

## 3. Schema / index changes (0434, additive only)

1. `handyman_service_requests (client_id, created_at, id)`
2. `handyman_visit_appointments (client_id, handyman_request_id, created_at DESC, id DESC)`
3. `handyman_execution_scope_assignments (execution_scope_id, assigned_at DESC, id DESC)`
4. `handyman_arrival_verification_results (execution_scope_id, evaluated_at DESC, created_at DESC, id DESC)`
5. `handyman_service_warranty_claims (execution_scope_id, created_at DESC, id DESC)` (was sequential-scan path)
6. `authentication_audit_events (created_at DESC, id DESC)`
7. `authentication_audit_events (user_id, created_at DESC, id DESC)`

Each maps to a named query callsite (migration header carries the SQL
evidence). No UNIQUE/FK-support index touched; no Request↔WorkOrder linkage;
no financial/audit/evidence records deleted, truncated or rewritten.

## 4. Tests (all on isolated PostgreSQL 16.14 unless noted)

| Suite | Result |
| --- | --- |
| `tests/config-db-pool.test.ts` + `tests/config.test.ts` (no DB) | 34/34 pass |
| `tests/db-opt-01-index-migration.test.ts` (migrate chain + 0434 up/down/up, index validity) | 5/5 pass |
| Full focused battery on clean PG 16.14 (config ×2, db-opt-01, database, audit, dispatcher, queue, appointments, SLA status/visibility) | **91/91 pass** |
| `tests/handyman-lifecycle-api.test.ts` + `tests/handyman-customer-payments.test.ts` + `tests/handyman-customer-payment-scope-guard.test.ts` | 16/18 pass — 2 failures reproduced identically on the **untouched base commit** (frozen file-list/OpenAPI snapshots; see audit §4.7). Not caused by this CR; left untouched. |
| `tests/fx01-part01-fx-rate-authority.test.ts` (attribution check) | 17/27 pass — identical failures on clean DB with base code and with this CR's code (era-stale "reversible" tests; audit §4.7) |
| `npm run typecheck` / `npm run build` | pass |
| Full-suite `tests/migrate.test.ts` ordering caveat | pre-existing (audit §4.7); reproduced on base commit |

API contracts, authorization results and transactional outcomes: unchanged
(queue/status/appointment/audit suites above exercise the changed paths).

## 5. Measured before/after (SYNTHETIC fixtures — not production)

PostgreSQL 16.14 scratch DB, volumes: 60k requests / 40k appointments / 40k
assignments / 36k arrival results / 36k claims / 200k audit events; median of
10 runs (3 warmups). Full plans: `scripts/db-bench/out/bench-results.json`.

| Query | Before | After | Δ |
| --- | --- | --- | --- |
| Q1 queue/customer-care list | 4.06 ms | 0.51 ms | −87% |
| Q2 workspace keyset | 2.87 ms | 0.41 ms | −86% |
| Q3 audit time-range page | 6.76 ms | 6.72 ms | −1% (sort removed; `COUNT(*) OVER()` dominates — honest null) |
| Q4 audit user-filter page | 4.99 ms | 0.54 ms | −89% |
| Q5 appointment list per request | 0.35 ms | 0.35 ms | ±0 (honest null) |
| Q6 assignment stage | 4.07 ms | 0.26 ms | −94% |
| Q7 arrival stage latest | 0.25 ms | 0.22 ms | −13% |
| Q8 warranty claims stage | 0.93 ms | 0.26 ms | −72% |

Index/storage overhead: audit table indexes 17→36 MB (200k rows, 2 new
composites); requests 12→15 MB; scope tables +2–3 MB each. No proven
production gains are claimed — these are synthetic fixture measurements.

## 6. Risks & follow-ups (documented, deliberately not implemented)

- Redundant-index cleanup (36 same-column pairs) — runbook §10, separate
  approval.
- Batched visibility read (replace per-item fan-out wholesale) — high-risk
  rewrite; current mitigation bounds pool pressure only.
- Stored SLA `breach_due_at` materialization — write-path change; not
  justified by current volumes.
- Hard LIMITs on Web-compatible unbounded lists (invoice-payment-status,
  pending approvals) — HTTP contract decision for the product owner.
- PgBouncer: session-level advisory locks block transaction pooling today
  (runbook §6).
- Test-tooling PG 18 vs deployment PG 16 skew — recommend pinning
  `embedded-postgres` to a 16.x build in a separate maintenance change.

## 7. Railway config guidance (summary; full: DBA runbook)

- Use the **private** `DATABASE_URL` for app traffic; `DB_*` vars override.
- Pool: `DB_POOL_MAX` ≤ (max_connections ÷ replicas) − headroom; defaults
  (10 / 5s / 30s) equal historical behavior.
- Opt in to `DB_STATEMENT_TIMEOUT_MS=30000` and
  `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=60000` after staging validation;
  migrations neutralize statement_timeout internally.
- Run migrations as an explicit one-shot job on a direct session; verify
  `indisvalid` + `schema_migrations` head (runbook §7).
- Alerting table in runbook §8; rollback in runbook §9.
