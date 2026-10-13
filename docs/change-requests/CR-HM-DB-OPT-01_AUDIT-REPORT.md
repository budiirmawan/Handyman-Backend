# CR-HM-DB-OPT-01 — PostgreSQL & Railway Optimization: Audit Report (PART 00)

Repository: `budiirmawan/Handyman-Backend`
Branch: `arena/6635d098-handyman-backend`
Baseline commit: `edf26c809edf6786c65ebc7edd2a8b0b4f826911`
Audit date: 2026-10-13

All measurements in this report were produced on an **isolated PostgreSQL
16.14 scratch instance** (embedded binaries, disposable database). **No
production database, Railway resource, or shared environment was touched.**
Synthetic fixture benchmarks are labeled as such and are not live production
measurements.

---

## 0. Baseline verification

| Item | Finding |
| --- | --- |
| Active branch / HEAD | `arena/6635d098-handyman-backend` @ `edf26c8` (working tree clean at start) |
| Migration chain | **433 migrations**, `0001_initial_foundation` … `0433_handyman_customer_payment_proof` |
| Historical note | The CR brief mentions "migrations had reached 0432"; the **actual latest is `0433`** (verified in `src/database/migrations/index.ts` and by running the full chain). New work therefore starts at **0434**. |
| Schema size (post-chain) | **423 tables**, **2054 indexes**, **2672 foreign keys**, ~370 CHECK constraints |
| Deployment baseline | PostgreSQL **16** (`docker-compose.yml` pins `postgres:16`; confirmed migrations apply cleanly on 16.14) |
| DB adapter | `pg` 8.23, single process-level `Pool` (`src/database/connection.ts`), `withTransaction` helper (`src/database/transaction.ts`) |
| Package scripts | `db:migrate` / `db:migrate:status` / `db:migrate:down` / `db:seed` / `db:migrate:prod`; migrations are **explicit** (never auto-run at boot) |
| Test DB tooling | Tests use `asentra_test` via `tests/helpers/postgres.ts`, with opt-in `embedded-postgres` (devDependency currently bundles PostgreSQL **18.4** binaries — version skew vs the 16.x deployment baseline is documented below) |
| Request↔WorkOrder relation | Unresolved by design. **No relation was invented, backfilled, or queried** in this CR. The operations queue still emits `handymanRequestId` only (`handyman-operations-queue.service.ts`). |

## 1. Migration framework

- Every migration runs inside one transaction (`migrate.ts → withTransaction`),
  recorded in `schema_migrations (id, applied_at)`.
- `migrateDown` reverts exactly the latest applied migration. Some `down`s are
  frozen-irreversible by design (e.g. `0369_create_saas_payments.down` throws
  "irreversible by frozen design") — the runner surfaces the error and the
  history row is retained (safe).
- **Gap found:** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
  block, and the framework had no non-transactional path. Addressed in PART 01
  (see change list): `Migration.transactional?: boolean`, default `true`
  (unchanged behavior for all historical migrations).
- **Gap found:** an operator-configured `statement_timeout` could abort long
  DDL mid-migration. The runner now disables `statement_timeout` for the
  duration of each migration (SET LOCAL in transactions; SET/restore on the
  non-transactional path).

## 2. Table inventory

Full generated inventory (every table: FKs, referencing tables, all indexes):
`docs/change-requests/CR-HM-DB-OPT-01_TABLE-INVENTORY.md`.

Focus areas named by the CR map to these authoritative tables (no parallel
models exist):

| Domain | Authoritative tables |
| --- | --- |
| Queue | `handyman_service_requests` (+ stage children), operations queue is a read adapter |
| Inspections | `handyman_request_inspections` (frozen F2, trigger-guarded append-only) |
| Appointments | `handyman_visit_appointments`, `handyman_visit_attempts`, `handyman_visit_capacity_reservations` (GiST no-double-book) |
| Requests | `handyman_service_requests`, `handyman_request_triage_decisions`, `handyman_request_diagnoses`, `handyman_request_referrals` |
| Work orders | `work_orders`, `work_order_assignments`, `work_order_actions` |
| Approvals | `reviews` (+ `documents` / `document_versions`), `management-pending-approval` read model |
| Invoice/payment verification | `invoice_payment_status`, `payment_receipts`, `tenant_invoices`, `handyman_customer_transactions`, `handyman_customer_payments`, `handyman_payment_allocations`, settlement tables |
| Audit | `authentication_audit_events`, `operational_events`, module-specific append-only event tables |
| Evidence | `evidence_submissions` (shared engine), `handyman_evidence_records` (+ files/events), retention policies |
| Manager/dashboard | `management-*` read modules (aggregates over the tables above; no copied state) |

## 3. Query callsite inspection (named hot paths)

1. **Operations queue** (`handyman-operations-queue.service.ts` →
   `listHandymanServiceRequestsPage` + `readHandymanRequestStatusVisibility`):
   bounded page (limit 1–50), correct scope guards (client + building wall).
   **N+1 fan-out found:** each page item triggers the SLA-status visibility
   read (`handyman-sla-status-api.service.ts`), which issues ~25 small point
   lookups per request (triage/diagnosis/referral, 3 readiness tables,
   quotation versions, 13 execution-scope stage queries, SLA candidates). A
   50-item page can therefore fan out ~1,250 queries at once onto the shared
   pool.
2. **Visibility stage queries** (`composeStatusVisibility`): several
   `WHERE execution_scope_id = $1 ORDER BY <ts> DESC, id DESC` lookups whose
   ordering keys were not covered by existing indexes (see §4). One query
   (`handyman_service_warranty_claims` by `execution_scope_id`) had **no
   leading-column index at all** — sequential scan per call.
3. **Customer-care / workspace request list**
   (`handyman-service-request.repository.ts`): `WHERE r.client_id = $1 …
   ORDER BY r.created_at ASC, r.id ASC` with optional keyset pagination —
   no supporting `(client_id, created_at, id)` index existed; sorts per call.
4. **Audit list** (`audit/repository`): filters `event_type` / `user_id` /
   `outcome` / `created_at` range, `ORDER BY created_at DESC, id DESC`,
   `COUNT(*) OVER()` for totals. Only single-column `(created_at)` / `(user_id)`
   indexes existed — sort + tie-break on every page.
5. **Due-job dispatcher** (`due-job-dispatcher.service.ts`): reminders,
   escalations, outbound deliveries and webhook jobs all retrieve due items
   with a bounded `LIMIT` (shared `DUE_ITEM_RETRIEVAL_LIMIT = 100`);
   **`appliedSlaRepository.findDueRunning` was the only unbounded due scan**
   (all due RUNNING clocks, `FOR UPDATE SKIP LOCKED`, no LIMIT).
6. **Appointments** (`handyman-appointment.repository.ts`): list by
   `(client_id, handyman_request_id) ORDER BY created_at DESC, id DESC`; the
   existing `(client_id, handyman_request_id, kind, created_at DESC)` index
   cannot serve this order (kind sits between filter and sort columns).
7. **Invoice/payment verification** (`invoice-payment-status.repository.ts`):
   joins invoices + status with `ORDER BY i.due_date DESC, ps.updated_at DESC`;
   **unbounded list** (all buildings in scope) — flagged, not changed (see §6).
8. **Management/dashboard reads** (`management-work-order-summary`,
   `management-pending-approval`, `management-financial-summary`, …): all
   aggregate over source tables with explicit building/client scope arrays
   (`= ANY($1::uuid[])`) and time windows; work-order summary benefits from
   existing `work_orders_building_idx (building_id, status, created_at)`.
   `reviews` pending-approval lookups use `reviews_client_idx` +
   `reviews_target_idx` — adequate at current shapes.
9. **Evidence retention execution**: bounded retrieval (`LIMIT` shared
   constant) over `retention_state` + `retained_until` with a partial index —
   correctly bounded and indexed.
10. **Transaction/payment writes** (`handyman-customer-payments`,
    `payment-allocation`, `settlement`): all use `withTransaction` or explicit
    `try/finally + release()`, status-guarded transitions and idempotency keys —
    no connection leaks found across all 16 raw `pool.connect()` callsites.

## 4. Gaps and findings

### 4.1 Index gaps (addressed in migration `0434_handyman_db_opt_indexes`)

Evidence-backed composites matched to real WHERE/JOIN/ORDER BY shapes (full
SQL evidence in the migration header):

| New index | Supports | Evidence |
| --- | --- | --- |
| `handyman_service_requests (client_id, created_at, id)` | queue/customer-care list + workspace keyset | `listCustomerCareProjectionsScoped`, `listWorkspaceProjectionsScoped` |
| `handyman_visit_appointments (client_id, handyman_request_id, created_at DESC, id DESC)` | appointment list per request | `listHandymanVisitAppointments` |
| `handyman_execution_scope_assignments (execution_scope_id, assigned_at DESC, id DESC)` | visibility assignment stage | `composeStatusVisibility` |
| `handyman_arrival_verification_results (execution_scope_id, evaluated_at DESC, created_at DESC, id DESC)` | visibility arrival stage | `composeStatusVisibility` |
| `handyman_service_warranty_claims (execution_scope_id, created_at DESC, id DESC)` | visibility warranty stage (was seq-scan) | `composeStatusVisibility` |
| `authentication_audit_events (created_at DESC, id DESC)` | audit list default order | `listAuditEvents` |
| `authentication_audit_events (user_id, created_at DESC, id DESC)` | audit list user-filtered | `listAuditEvents` |

Overlap audit (before adding): none of the seven duplicates an existing
index; two legacy single-column indexes
(`authentication_audit_events_created_at_idx`, `…_user_id_idx`) become
prefix-redundant afterwards and are listed in the runbook's optional,
separately-approved cleanup. No UNIQUE or FK-support index was changed.

### 4.2 Redundant index candidates (NOT changed in this CR)

An automated exact-column overlap scan of the full 2054-index inventory found
**36 same-column index pairs** where a plain btree duplicates a unique
(non-partial) index, e.g. `work_orders_request_idx (work_request_id)` vs
`work_order_from_request_unique`, `handyman_quotation_versions_thread_idx`
vs `handyman_quotation_versions_pair_unique`,
`document_versions_document_idx` vs `document_versions_document_version_unique`,
`service_catalog_client_code_idx` vs `service_catalog_client_code_unique`,
`bast_documents_document_idx` vs `bast_documents_document_id_key`, …
(Index direction nuances on a few pairs need manual verification before any
drop.) Cleanup is listed in the DBA runbook as an explicitly-approved,
separately-executed step — **not** part of the additive migration.

### 4.3 N+1 / fan-out

- Operations queue per-item visibility fan-out (§3.1): mitigated by resolving
  items in small concurrent batches (`VISIBILITY_BATCH_SIZE = 4`) — identical
  output/order, bounded pool pressure. A full batched rewrite of the
  visibility read is deliberately deferred (1,177-line service; risk of
  divergence between queue and status API is high). Documented as follow-up.
- `checklist-administration` repository `findItem`/`createItem` issue a couple
  of extra point reads per call — small, bounded, left unchanged.

### 4.4 Unbounded listings (flagged; contracts preserved)

- `invoice-payment-status.list` — no LIMIT (Web-compatible unbounded
  convention; `docs` mobile pagination contract allows opt-in paging).
- `management-pending-approval.listPendingDocumentApprovals` — no LIMIT.
- `findDueRunning` — **changed**: now `ORDER BY started_at, id LIMIT ≤100`
  (same bounded pattern as every other due queue; remaining items are picked
  up on the next dispatcher tick; status-guarded `markBreached` keeps
  idempotency).

### 4.5 Hot rows / long transactions

- `sla_clocks` breach scanning evaluates a per-row pause-interval expression
  over all RUNNING clocks; the partial `sla_clocks_breach_due_idx` narrows the
  set but cannot index the computed due time. A stored `breach_due_at`
  materialization would help at very large scale — deferred (write-path change
  to SLA semantics; not justified by current evidence).
- Booking/concurrency, payment verification and settlement paths already use
  row locks + `FOR UPDATE`/`SKIP LOCKED` + idempotency keys; no changes made.

### 4.6 PostgreSQL 16 / Railway runtime constraints

- Pool was hard-coded (`max: 10`, `idleTimeoutMillis: 30_000`,
  `connectionTimeoutMillis: 5_000`); no `statement_timeout`, no
  `application_name`, no `DATABASE_URL` support (only `DB_HOST`/`DB_PORT`/…).
  All addressed in PART 02 with validated env vars and conservative defaults
  identical to the old values.
- Health/readiness: `/api/v1/health/database` (pool `SELECT 1`) wired as
  Docker/Railway healthcheck — kept unchanged.
- Graceful shutdown: scheduler drain → `server.close()` → `closePool()` —
  kept; bounded force-exit added (see change list).
- **PgBouncer compatibility:** `utility-ocr-candidate.service.ts` uses
  *session-level* `pg_advisory_lock`/`pg_advisory_unlock`; several modules use
  transaction-scoped `pg_advisory_xact_lock` (safe). Session advisory locks
  and any session-state assumptions make **transaction-pooling PgBouncer
  incompatible** without code changes — see DBA runbook §PgBouncer.
- Test-tooling skew: repo `embedded-postgres` devDependency bundles PG 18.4
  while deployment targets PG 16. Benchmarking/migration verification for
  this CR ran on PG 16.14 specifically.

### 4.7 Pre-existing test findings (not caused by this CR; verified on the untouched base commit)

- `tests/migrate.test.ts` "applies pending migrations only once": requires an
  empty `schema_migrations` at start; when earlier test files (e.g.
  `areas.test.ts`) have already applied the chain, its rollback loop sticks on
  the frozen-irreversible `0369` down and the re-apply assertion fails.
  Reproduced identically on the untouched base commit — recorded as test
  order debt, not modified here.
- `tests/fx01-part01-fx-rate-authority.test.ts` (and the same pattern in
  `form-instance-generated-task-binding.test.ts`,
  `mobile-shift-security-post-migration.test.ts`,
  `tenant-intake-provenance-part01.test.ts`,
  `work-order-field-purchase-request-parent.test.ts`): "migration is
  reversible" tests assert `migrateDown` reverses **their** migration
  (e.g. `0333`) — an era-specific assumption that the target migration is the
  chain head. On a clean database these fail identically on the base commit
  and with this CR's code (fx01: 17/27 both ways). Stale-snapshot debt.
- `tests/handyman-customer-payments.test.ts` "firewall sweep": frozen file
  list misses the existing `handyman-customer-payment.available-actions.ts`.
- `tests/handyman-lifecycle-api.test.ts` "8-operation surface": frozen OpenAPI
  snapshot predates the readiness/quotation routes now present.
  Both reproduced on the base commit.
- **Mixed-binary caveat (ops hygiene):** a rollback/re-apply cycle driven by a
  runner whose migration registry predates `0434` (e.g. an old binary or a
  detached worktree of an earlier commit) can drop Handyman tables while the
  `0434` history row remains, leaving 0434 recorded but its indexes gone.
  With a single consistent binary the cycle is self-healing (0434 is rolled
  back first, re-applied last). Rule: never point mixed migration binaries at
  one database; `tests/db-opt-01-index-migration.test.ts` detects and repairs
  this state.

## 5. Performance baseline (synthetic fixtures — NOT live measurements)

Harness: `scripts/db-bench/run-bench.ts` (reproducible; PostgreSQL 16.14;
60k requests / 40k appointments / 40k assignments / 36k arrival results /
36k warranty claims / 200k auth-audit events; FK triggers disabled during
load in the disposable benchmark DB; ANALYZE after load; median of 10 runs
after 3 warmups). Full EXPLAIN (ANALYZE, BUFFERS) plans:
`scripts/db-bench/out/bench-results.json`.

| Query shape | Before (median) | After (median) | Δ |
| --- | --- | --- | --- |
| Q1 customer-care/queue list (client, created ASC) | 4.06 ms | 0.51 ms | −87% |
| Q2 workspace keyset page | 2.87 ms | 0.41 ms | −86% |
| Q3 audit list (time-range page + COUNT OVER) | 6.76 ms | 6.72 ms | −1% (sort removed; `COUNT(*) OVER()` dominates) |
| Q4 audit list (user filter) | 4.99 ms | 0.54 ms | −89% |
| Q5 appointment list per request | 0.35 ms | 0.35 ms | ±0 (5 rows/request; planner seq-scans either way — honest null result) |
| Q6 execution-scope assignment stage | 4.07 ms | 0.26 ms | −94% |
| Q7 arrival stage latest | 0.25 ms | 0.22 ms | −13% |
| Q8 warranty claims stage | 0.93 ms | 0.26 ms | −72% |

Index/storage overhead (200k-row audit table etc.): e.g.
`authentication_audit_events` index size 17→36 MB (two composites),
`handyman_service_requests` 12→15 MB, scope tables +2–3 MB each. Modest,
one-time write amplification; no data rewrite.

## 6. Risks and change plan (implemented)

1. **Migration `0434_handyman_db_opt_indexes`** — additive, `transactional:
   false`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` + post-build validity
   check. Production execution plan in the DBA runbook (direct session, not
   pooled; runbook rollback via `DROP INDEX CONCURRENTLY`).
2. **Pool/config hardening** — `DATABASE_URL` (Railway private) support with
   field-level `DB_*` overrides; validated `DB_POOL_MAX/MIN`,
   `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`,
   `DB_STATEMENT_TIMEOUT_MS` (default **0 = disabled**),
   `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default 0); `application_name`
   observability. Defaults equal historical behavior.
3. **Bounded retrieval** — `findDueRunning` now bounded/FIFO; queue visibility
   fan-out resolved in small batches.
4. **Deferred (documented, not implemented):** batched visibility read,
   stored SLA due-time materialization, redundant-index cleanup, hard LIMITs
   on Web-compatible unbounded lists (contract decision), PgBouncer adoption.

**Authority preserved:** no lifecycle/role/permission/occupancy/work-order/
inspection/appointment/quotation/financial/audit/evidence semantics changed;
booking/payment/settlement/QC/idempotency authority untouched; no
Request↔WorkOrder relation invented; no data deleted or rewritten.
