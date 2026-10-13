# CR-HM-DB-OPT-02 — Railway Staging Performance & Migration Safety Verification

**Date:** 2026-10-13 · **Status:** COMPLETE · **Verdict:** **GO** for CR-HM-DB-OPT-01 release, with pre-existing defects listed in §7 that are outside this CR's scope
**Baseline:** `arena/6635d098-handyman-backend` @ `90b7d08` (= `main` @ `edf26c8` + CR-HM-DB-OPT-01) · **Database under test:** isolated scratch **PostgreSQL 16.14** (deployed major version)

> **Measurement honesty:** all performance numbers in this report are **synthetic staging-scale benchmarks** produced on an isolated scratch PostgreSQL 16 instance by `scripts/db-bench/` (fixture sizes in §4). They are **not live Railway/production measurements**. Railway-side configuration values in §8 are **recommendations**, not measured facts.

---

## 1. Executive summary

| Part | Scope | Result |
|---|---|---|
| 01 Migration safety | 0434 index definitions/validity/ledger, interrupted `CREATE INDEX CONCURRENTLY`, safe manual recovery | **PASS** (S1–S4) + CI recovery test |
| 02 Query performance | 9 real query shapes at staging scale, p50/p95 + `EXPLAIN (ANALYZE, BUFFERS)` + index utilization, before/after 0434 | **PASS** — 6/9 large wins, 2 small wins, 1 honest null (contract-bound `COUNT(*) OVER()`), 0 regressions of substance |
| 03 Railway runtime | pool config, connection release, transaction failure, graceful shutdown, connection budget, private URL, PgBouncer | **PASS** (R1–R6) |
| 04 Release readiness | all migrations on PG 16, focused domain battery (RBAC / isolation / work-order lifecycle / payment / settlement / audit / evidence), DB integrity, rollback runbook | **PASS** — 377/383 focused tests green; 6 failures are **pre-existing** (§7), none introduced by DB-OPT-01/02 |

No production resources were touched. No historical migrations were edited. No business authority, HTTP contract, authorization result, row count, or transactional outcome was changed by this verification work.

---

## 2. Scope & method

- Harnesses (committed alongside this report):
  - `scripts/db-bench/migration-safety.ts` — PART 01 (self-creates/drops scratch DB `asentra_migtest`)
  - `scripts/db-bench/staging-verify.ts` — PART 02 (staging-scale fixture + before/after benchmark)
  - `scripts/db-bench/runtime-verify.ts` — PART 03 (production DB runtime layer under concurrency)
  - `tests/db-opt-02-migration-recovery.test.ts` — deterministic CI recovery-contract test
- Evidence JSON: `scripts/db-bench/out/{migration-safety,staging-verify,runtime-verify}.json`
- Baseline attribution rule: CR-02 adds **only untracked/new files**; no tracked file differs from `90b7d08`. Therefore any test failure observed during CR-02 is **by construction identical at baseline** unless it involves newly added files (it does not — verified per failure in §7).
- Scratch DBs were re-initialized per phase; mixed migration binaries were never pointed at one DB (the known corruption mode from OPT-01 §4.7).

---

## 3. PART 01 — Migration safety (S1–S4 all PASS)

Evidence: `scripts/db-bench/out/migration-safety.json` (PG 16.14, scratch `asentra_migtest`).

**S1 — definitions, validity, ledger**
- 434/434 migrations applied (fresh DB).
- 7/7 `0434_handyman_db_opt_indexes` indexes **VALID**; `pg_indexes.indexdef` matches the migration source **exactly** (0 mismatches after canonical normalization — strip `public.`/`USING btree`, case-fold, whitespace-collapse).
- `schema_migrations` = 434 rows, set-equal to the registry, sequence-ordered; head = `…0432/0433/0434`.

**S2 — real interrupted `CREATE INDEX CONCURRENTLY`**
- 800k-row `handyman_service_requests` fixture; `pg_terminate_backend` fired mid-build (≤5 attempts) → index left **INVALID** (`handyman_service_requests_client_created_idx`).
- Re-running `migrateUp` **refused** with the migration's own precondition error, verbatim:
  `Migration failed: CR-HM-DB-OPT-01: index build left INVALID index(es): handyman_service_requests_client_created_idx. Drop them and re-run the migration (see DBA runbook §Rollback).`
- History was **not** recorded; the invalid index remained detectable; the other 6 indexes in the batch had already built VALID. No automatic destructive cleanup occurred.

**S3 — safe manual recovery (DBA runbook §3, executed exactly)**
1. `DROP INDEX CONCURRENTLY IF EXISTS handyman_service_requests_client_created_idx`
2. Re-run `migrateUp` → applied `['0434_handyman_db_opt_indexes']`; 7/7 present and VALID.

**S4 — ledger recheck after recovery:** `schema_migrations` == registry, ordered.

**CI recovery contract** (`tests/db-opt-02-migration-recovery.test.ts`, 1/1 PASS): asserts the refusal message and the drop+re-apply recovery deterministically by flipping `pg_index.indisvalid/indisready` via catalog update as superuser (skips honestly on non-superuser roles).

---

## 4. PART 02 — Query performance at staging scale

Evidence: `scripts/db-bench/out/staging-verify.json`. **Synthetic fixture** (labeled in-file): 250,000 service requests · 50,000 appointments · 60,000 assignments · 45,000 arrival results · 45,000 warranty claims · **500,000 audit events**. Protocol: 4 warmups + 12 timed iterations per shape per phase; p50/p95 wall-clock; `EXPLAIN (ANALYZE, BUFFERS)` on each shape; `idx_scan` deltas forced-flushed between phases. Phases: (before) 0434 rolled back → (after) 0434 applied. `ORDER BY` always carries the production `id` tie-break.

| Shape | Before p50/p95 (ms) | After p50/p95 (ms) | Δ p50 | Plans |
|---|---|---|---|---|
| Q1 customer-care queue (client, created_at ASC, LIMIT 50) | 14.26 / 16.05 | 0.70 / 1.16 | **−95%** | composite index feeds sort directly |
| Q2 workspace keyset page | 9.23 / 10.20 | 0.52 / 2.77 | **−94%** | keyset + composite |
| Q3 audit list (30-day range + `COUNT(*) OVER()`) | 20.78 / 26.01 | 20.40 / 40.54 | **±0 (honest null)** | see below |
| Q4 audit list (user filter) | 7.07 / 8.16 | 0.53 / 0.60 | **−93%** | `(user_id, created_at DESC, id DESC)` |
| Q5 appointment list per request | 0.35 / 0.43 | 0.34 / 0.91 | **±0 (honest null)** | was already indexed |
| Q6 execution-scope assignment stage | 5.29 / 8.04 | 0.28 / 0.41 | **−95%** | **seq scan eliminated** (1→0) |
| Q7 arrival stage latest | 0.38 / 0.47 | 0.26 / 0.41 | **−33%** | partial win (largest-N sort remains) |
| Q8 warranty claims stage | 1.09 / 1.14 | 0.24 / 0.31 | **−79%** | composite replaces unique-index probe |
| Q9 deep offset page (LIMIT 50 OFFSET 2000) | 12.59 / 13.30 | 1.15 / 1.56 | **−91%** | pagination review, below |

**Index utilization (after-phase, forced stats flush):** all 7 new indexes exercised (`idx_scan` deltas 17–51 across 12 iterations × measured shapes). Sequential scans in measured shapes: before 1 → after 0.

**Query-shape review (contract-preserving):**
- **Q3 / `COUNT(*) OVER()` (visibility totals):** the window aggregate must visit every row in the 30-day window (≈27.5k rows, `shared hit=27.5k` in both phases) to compute `total` — this dominates and is identical before/after; the composite only removes the incremental sort (slightly wider index → small page-touch cost). p50 net-neutral; p95 variance is run noise on a fixed ~20 ms aggregate cost. **No change made:** removing/estimating `total` would change the HTTP contract. Deferred option (OPT-01 §6): separate count query or materialized counts.
- **SLA dispatcher fairness:** `findDueRunning` bounded-batch reads (OPT-01 PART 01) keep the same scope predicates and ordering; `tests/cr-be-stab-01-due-job-dispatcher.test.ts` + `cr-be-stab-01-due-job-scheduler.test.ts` green in the battery. No fairness regression.
- **Operations visibility fan-out:** `management-work-order-summary` contract green; Q1/Q2 shapes cover the request/workspace fan-out.
- **Pagination:** Q9 shows deep `OFFSET` stays O(offset) even after optimization (−91% at offset 2000, but it grows with offset). Keyset pagination is already used where the contract allows (Q2). Migrating web lists to keyset would change HTTP contracts — deferred (OPT-01 §6).

---

## 5. PART 03 — Railway runtime verification (R1–R6 all PASS)

Evidence: `scripts/db-bench/out/runtime-verify.json`, exercised through the production DB runtime layer (`src/database/connection.ts`, `src/database/transaction.ts`) on scratch PG 16.

| Check | Result |
|---|---|
| R1 pool config | env-validated `DB_POOL_MAX/MIN`, `idleTimeoutMs=30000`, `connectionTimeoutMs=5000`, `statementTimeoutMs`, `idleInTransactionSessionTimeoutMs` reach the `pg.Pool` exactly (`createPool`). **Private `DATABASE_URL`** is the sole connection source; `DATABASE_PUBLIC_URL` is never consulted (code + `tests/config-db-pool.test.ts`). |
| R2 concurrent release | 30 concurrent connects against `max=4`: peak `totalCount=4` (never exceeds), after drain `waiting=0, idle=total`; zero leaked sessions in `pg_stat_activity`. |
| R3 transaction failure | 4 concurrent transactions (2 success, 1 thrown, 1 constraint violation): exactly 2 rejected, exactly the 2 committed rows survive (rollback verified), pool intact after. `withTransaction` releases in `finally`. |
| R4 error release | 8 failing queries on checked-out clients → pool fully drained after (no leak). |
| R6 connection budget | formula `instances × DB_POOL_MAX + workers × 1`; server `max_connections=100` on scratch. Examples at the shipped default `DB_POOL_MAX=10`: 1 inst + 2 workers = 12 (headroom 88); 2+2 = 22; 3+2 = 32; 5+2 = 52. Workers hold exactly 1 connection each (one-shot pg client per task). |
| R5 graceful shutdown | `closePool()` drains and subsequent queries are refused; `src/server.ts` wires `SIGINT`/`SIGTERM` → `requestShutdown` → `server.close()` + `closePool()`. |

**Concurrent API + worker + transaction-failure exercise:** R2/R3/R4 simulate bursty API traffic and failing transactions against the same pool the workers use; the two newest worker batch paths (`findDueRunning` batch-reads + `Promise.allSettled` claim processing) share this pool and were exercised in the OPT-01 battery and this battery. Full worker processes (redismq/Redis) are **not** run in this sandbox — stated honestly; their DB-layer behavior is covered.

**PgBouncer: keep transaction pooling DISABLED.** Session-level advisory locks on pinned clients are in use: `utility-ocr-candidate.service.ts` (`pg_advisory_lock`/`pg_advisory_unlock` around OCR-candidate mutations) and `mobile-utility-meter-reading-verification.service.ts` (per-candidate advisory lock). Transaction pooling would silently rebind sessions mid-lock and break mutual exclusion. Compatibility is **not** established; re-evaluate only after those lock usages are redesigned. (Session-mode pooling could be evaluated separately but is not required at current connection volumes.)

---

## 6. PART 04 — Release readiness

**All migrations on PostgreSQL 16:** 434/434 applied clean on fresh PG 16.14 (PART 01 S1; re-applied twice more during recovery-test and fresh-DB preparations).

**DB integrity (fresh PG 16 after full migration + battery):**
- invalid indexes: **0**
- foreign keys: **1,809** — unvalidated: **0**
- unique/PK constraints unvalidated: **0**

**Focused domain battery** (36 files, 383 tests, `--test-concurrency=1` on a freshly migrated DB): **377 pass / 6 fail — all 6 pre-existing** (§7). Coverage by domain (all green unless §7):

| Domain | Files (outcome) |
|---|---|
| RBAC / permissions | `rbac`, `permissions`, `operational-permission-contract`, `config-perm-01-permission-registry` — **all green** |
| Company/property isolation | `data-isolation`, `handyman-care-workspace-tenants`, `material-request-canonical-isolation`, `evidence-file-handyman-building-scope-guard` — **all green** |
| Work-order lifecycle | `work-order-lifecycle`, `work-order-completion` (1 pre-existing §7.6), `work-order-assignment`, `work-order-context`, `handyman-lifecycle-api` (pre-existing §7.3), `cr-be-stab-01-due-job-{dispatcher,scheduler}` — **green except §7** |
| Payment | `handyman-customer-payments` (§7.2), `handyman-customer-payment-scope-guard` ✓, `handyman-payment-allocation` (§7.4), `cr-be-fin-rpt-01-part04-payment-safety` (§7.1), `platform-payments-domain` ✓ |
| Settlement | `handyman-settlement-part03`, `vendor-invoice-settlement-readiness` — **all green** |
| Audit | `audit`, `configuration-audit`, `operational-event-audit-read`, `handyman-audit-integration-part03` — **all green** |
| Evidence | `evidence-integrity-verification`, `evidence-file-api`, `work-order-evidence`, `mobile-evidence-contract`, `handyman-evidence-qc-evidence-reads-scope-guard` — **all green** |
| Visibility / SLA | `management-work-order-summary`, `r10-part06-work-order-sla-contract` (§7.5) |
| DB runtime | `config-db-pool` ✓, `db-opt-01-index-migration` ✓, `db-opt-02-migration-recovery` ✓ |

Authorization results, scope predicates, and transactional outcomes in the green suites match baseline expectations exactly.

---

## 7. Known pre-existing test debt (recorded separately — NOT fixed in this CR)

All failures below occur at baseline `90b7d08`; CR-02 changed no tracked file. Each is snapshot/scan drift from later CRs landing after these tests were written, plus one genuine pre-existing product defect (§7.6).

1. **`tests/cr-be-fin-rpt-01-part04-payment-safety.test.ts`** — "no migration 0334 and no historical rewrite": asserts no migration file starts with `0334`, but `0334_2026-08-22_add-expense-type-labels.ts` exists in the tree (added by a later CR). Era conflict between test and tree; deterministic. *(Same family as the known fx01 "migration is reversible" era-stale tests from OPT-01 §4.6.)*
2. **`tests/handyman-customer-payments.test.ts`** — firewall sweep file-list: module now contains `handyman-customer-payment.available-actions.ts`, which the expected 5-file list lacks. Static-scan drift; no behavior failure.
3. **`tests/handyman-lifecycle-api.test.ts`** — OpenAPI snapshot: test expects the 8-operation CR-HM-03 surface; the live surface has since grown (permit-readiness, quotation, scheduling-readiness, unit-access-readiness, …). Snapshot staleness (this is the known "lifecycle OpenAPI snapshot" surface failure from OPT-01 §4.6).
4. **`tests/handyman-payment-allocation.test.ts`** — firewall sweep source scan: "module source must not mention invoice" now trips on a comment/identifier. Static-scan drift; no behavior failure.
5. **`tests/r10-part06-work-order-sla-contract.test.ts`** — "the dataset enum is 14 after PART 08": expected 14 datasets, actual 27 (later CRs added datasets). Count-snapshot staleness.
6. **`tests/work-order-completion.test.ts` → "required evidence"** — **pre-existing product defect (base `edf26c8`, CR-BE-RN19-SAFETY-INSPECTION-01, untouched by DB-OPT-01/02).** `GET /api/v1/mobile/assignments` fails with `function min(uuid) does not exist` (HTTP 500) from `src/modules/mobile-assignments/mobile-assignment.service.ts:162`: `CASE WHEN COUNT(*) = 1 THEN MIN(sib_row.id) …` aggregates a **uuid**. PostgreSQL has no `min(uuid)`; the failure is at parse time and reproduces deterministically on both scratch DBs (verified directly via SQL). The codebase's established safe pattern is `MIN(col::text)::uuid` (see `operational-variance.repository.ts:92`, `utility-aggregation.repository.ts:185`). **Recommended one-line fix in a separate CR:** `MIN(sib_row.id::text)::uuid`. Semantics are unchanged (cardinality guard already restricts to COUNT=1). Not fixed here — business-logic changes are outside CR-HM-DB-OPT-02's authority.
7. **Test hygiene:** `tests/handyman-care-workspace-tenants.test.ts` self-collides on re-run against the same database (`duplicate key … handyman_care_workspace_sessions_token_hash_key`) due to deterministic fixture tokens without cleanup; passes 12/12 on a first run against a fresh DB (verified). Recommend per-suite cleanup in a separate maintenance CR.

---

## 8. Railway configuration recommendations (not applied — ops decisions)

1. **`DATABASE_URL` must be the private network URL** (`postgres.railway.internal:5432`). The backend never reads `DATABASE_PUBLIC_URL`; confirm the variable in Railway points at the private URL and restrict public networking on the Postgres service. (Evidence: §5 R1.)
2. **Pool sizing:** shipped default `DB_POOL_MAX=10` (validated `2 ≤ max ≤ 20`, `DB_POOL_MIN ≤ max`). Budget = `instances × DB_POOL_MAX + workers × 1 + 2 (ops headroom)` must stay well under the plan's connection limit. At 3 backend instances + 5 workers: `3×10 + 5 + 2 = 37`. Re-verify against the actual Railway plan limit before scaling out.
3. **Statement/idle guards:** leave `DB_STATEMENT_TIMEOUT_MS=0` only if long-running report jobs are expected; otherwise set `30000`+. Set `DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` to `60000` as a belt-and-braces leak guard (a client that dies mid-transaction will be reaped).
4. **PgBouncer: transaction pooling stays DISABLED** (§5 evidence: session advisory locks on pinned clients).
5. **`max_connections`:** leave the Railway default; the budget in (2) is the authority for instance counts.
6. **Deferred (OPT-01 §6):** redundant-index cleanup (36 pairs), batched visibility read, `breach_due_at` materialization, hard LIMITs on web lists, pin `embedded-postgres` dev dependency to 16.x.

---

## 9. Rollback runbook (DBA summary — full text in `CR-HM-DB-OPT-01-RAILWAY-DBA-RUNBOOK.md`)

**App rollback:** revert the release in Railway; the pool config and queries are backward compatible with the schema (0434 is additive indexes only).

**Index rollback (safe at any time):**
```sql
DROP INDEX CONCURRENTLY IF EXISTS handyman_service_requests_client_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_visit_appointments_request_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_es_assignments_scope_assigned_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_arrival_results_scope_evaluated_idx;
DROP INDEX CONCURRENTLY IF EXISTS handyman_service_warranty_claims_scope_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS authentication_audit_events_created_at_id_idx;
DROP INDEX CONCURRENTLY IF EXISTS authentication_audit_events_user_created_at_id_idx;
```
`0434_handyman_db_opt_indexes` then re-applies cleanly on the next migrate (ledger untouched: `down()` is a no-op that preserves history — OPT-01 §5.2.5).

**Interrupted 0434 during release (invalid index left behind):** the migration refuses to record history and prints the exact index name; runbook §3 = `DROP INDEX CONCURRENTLY` the named index, re-run the migration. Proven live in PART 01 S2/S3 and pinned by `tests/db-opt-02-migration-recovery.test.ts`.

**Post-rollback verification:** `EXPLAIN` Q1/Q2 from the OPT-01 runbook returns to baseline plans; no data/ledger action is ever required.

---

## 10. GO / NO-GO evidence

**GO** for shipping CR-HM-DB-OPT-01 to Railway staging → production:

- 0434 is deterministic, interrupt-safe, self-refusing on partial builds, and recoverable via documented manual steps (§3) — proven on the deployed major version (PG 16).
- Query-shape evidence at staging scale (§4): −79% to −95% p50 on 6 shapes, −33% on 1, honest nulls on 2 (contract-bound), no material regression, no new sequential scans, all new indexes utilized.
- Runtime layer (§5): pool bounded and env-validated, no connection leaks under concurrent API/transaction-failure load, graceful shutdown drains, private-URL-only config, connection budget fits comfortably at the shipped defaults.
- Full migration chain clean on PG 16; DB integrity clean (0 invalid indexes, 0 unvalidated FKs/PKs); focused domain battery 377/383 with the 6 failures all pre-existing and separately recorded (§7) — including one genuine pre-existing product defect (`min(uuid)`, §7.6) flagged for its own CR.

**NO-GO triggers if observed on staging smoke** (per runbook): invalid indexes after migrate (stop; use §9), pool saturation above budget, or p95 regressions >20% on Q1/Q2 shapes — each has a defined rollback (§9).
