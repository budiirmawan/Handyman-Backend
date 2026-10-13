# CR-HM-RAILWAY-STAGING-01 — Railway PostgreSQL 16 Staging Readiness & Smoke Validation

**Date:** 2026-10-13 · **Branch:** `arena/6635d098-handyman-backend` · **Baseline HEAD:** `8688184` (verified, clean tree)

> **Measurement honesty:** all numbers here come from a **local rehearsal** against isolated scratch PostgreSQL 16.14 in this workspace (real HTTP server, real migrations, real fixtures). They are **not** live Railway measurements. Railway-staging/production values are explicitly gated below. Datasets: local rehearsal (100k service requests), CR-02 synthetic staging-scale (250k + 500k audit), production (unknown) — **not mutually comparable**; cross-references are directional only.

---

## 1. Executive status

| PART | Scope | Status |
|---|---|---|
| 01 Baseline & configuration | HEAD/tree/migrations/build/reports, deployment config, private URL/SSL/Node, topology, connection budget, advisory locks | **DONE — GO** |
| 02 Staging preflight | staging environment discovery, ledger/index read-only checks, backup/restore + 0434 procedure | **DONE except live staging inspection** — no accessible Railway staging from this environment (see §2) |
| 03 API & DB smoke | health, mobile feed incl. UUID fix, key flows, no min(uuid), RBAC/isolation/idempotency | **REHEARSAL DONE — GO** (20/20 smoke checks + 181/181 tests); live staging run **GATED** |
| 04 Runtime performance | pool vs connections, p50/p95, plans, utilization, logs | **REHEARSAL DONE**; live staging metrics **GATED** |
| 05 Release readiness | GO/NO-GO matrix, DBA staging runbook, rollback, monitoring, test debt | **DONE** — runbook: `CR-HM-RAILWAY-STAGING-01-DBA-STAGING-RUNBOOK.md` |

**Overall: CONDITIONAL GO.** The repository artifacts (0434 + UUID fix + pool config) are staging-ready by every check executable in this environment. **NO-GO for production** until an operator with Railway access executes the live checklist (runbook §6) and the live gates in §5 clear.

## 2. Staging environment access (PART 02 gate)

- The repository contains the deployment definition (`railway.json`, `Dockerfile`) but **no staging environment credentials, URLs, or Railway API access** are available in this workspace (outbound network is restricted to GitHub/npm/PyPI hosts). Per the execution rules this is the **absent-staging-access stop** for the live-only steps.
- Therefore: **no services were created, no deploys issued, no environment variables altered, no staging/production database touched.** All staging actions below are prepared for an operator (runbook §3–§6).
- Staging discovery checklist for the operator: confirm a dedicated staging service exists, points at a **separate** Postgres service (not the production DB), `DATABASE_URL` is the private endpoint, and the migration one-shot is configured as a pre-deploy job.

## 3. PART 01 evidence — baseline & configuration

| Check | Result |
|---|---|
| HEAD / tree | `8688184`, tracked tree clean, matches expected HEAD |
| Migrations | **434 files, contiguous 0001–0434**, none missing, none beyond 0434; applied ledger = 434 on fresh PG 16 (via `tests/db-opt-02-migration-recovery.test.ts`, 1/1 green) |
| Build | `npm run typecheck` clean; `npm run build` (tsc) clean |
| Existing CR reports | 6 present: DB-OPT-01 ×4, DB-OPT-02, MOBILE-ASSIGN-UUID-01 |
| Deployment config (no secrets) | `railway.json`: Dockerfile builder, `node dist/server.js`, healthcheck `/api/v1/health`, ON_FAILURE ×5. `Dockerfile`: Node 22 slim, dist-only, non-root, **explicit migrations only** |
| Runtime Node | 22 (image) / `engines >= 20` |
| Private `DATABASE_URL` | sole connection source; `DATABASE_PUBLIC_URL` never consulted (`src/config/env.ts` + `tests/config-db-pool.test.ts`) |
| SSL | `DB_SSL` boolean or `sslmode` query mapping, validated values; private-network default documented (runbook §2) |
| Service health | `GET /api/v1/health` (liveness) + `GET /api/v1/health/database` (readiness) — verified live in rehearsal |
| PG major | scratch rehearsal = **16.14** (deployed major); live Railway `SHOW server_version` is a staging gate |
| Topology | single service; DueJobScheduler **in-process** (drained ≤5 s on SIGTERM). No separate worker service defined in repo |
| Connection budget | `replicas × DB_POOL_MAX + 2`; table for 1–3 replicas in runbook §2; live `max_connections` + replica count are staging gates |
| Advisory locks | session-level `pg_advisory_lock` on pinned clients preserved; **PgBouncer transaction pooling remains disabled** |

## 4. PART 03/04 rehearsal evidence (isolated PG 16.14, real HTTP server)

**Harness:** `scripts/db-bench/staging-smoke.ts` → evidence `scripts/db-bench/out/staging-smoke.json`. **Result: 20/20 PASS.**

- **Health:** `/api/v1/health` 200; `/api/v1/health/database` 200 `connected`.
- **Mobile feed (UUID fix):** anonymous → 401; missing permissions → 403; permissioned empty identity → `200 []`; scoped worker → 200 with `safetyInspectionBindingId` = binding id for exactly-one ACTIVE binding (marker semantics); cross-company task + binding **absent** (company/property isolation); `?page/pageSize` 200; `?shift=current` 200; invalid `?shift` 400. **No `min(uuid)` error on any path** (and the server property is pinned: raw `SELECT MIN(uuid)` still rejects on PG 16 — the application no longer relies on it).
- **Key-flow reads:** operations queue `?clientId=…` 200 (client-scoped contract), work-orders/team 200, audit events 200, care requests → **401 by contract** (care workspace uses its own session token; ordinary JWTs must be rejected — care data flows verified in the focused suites).
- **Measured local latency (p50/p95 ms, 25 iterations/endpoint, local-only):** mobile feed 15.2/27.9 · feed paged 16.1/22.4 · operations queue 11.7/20.7 · work-orders team 9.0/12.3 · audit events 6.2/8.0.
- **Connection hygiene during workload:** pool total 4 / idle 4 / waiting 0 (max 10); `pg_stat_activity` 4 total / 1 active — no leaks (consistent with CR-HM-DB-OPT-02 R2–R4).
- **Q1/Q2 plans (100k-row local fixture):** both use `handyman_service_requests_client_created_idx` (Q2 with `ROW(created_at,id)` keyset condition), `shared hit=6` for 50 rows — **directionally consistent** with the CR-02 synthetic findings (same index, same shape); latencies are not comparable across datasets.
- **Idempotency:** repeated safe reads return identical responses across the workload iterations (25×5 endpoints, all 200, stable shapes).

**Key-flow test battery (fresh PG 16 DB, serial): 181/181 PASS** across rbac, data-isolation, work-order-lifecycle, work-order-completion, handyman-care-workspace-tenants, handyman-operations-queue, handyman-request-inspection, inspection-bindings, handyman-appointment-core, handyman-customer-payment-scope-guard, platform-payments-domain, handyman-settlement-part03, audit, operational-event-audit-read, evidence-integrity-verification, config-db-pool, db-opt-01-index-migration, mobile-assign-uuid-01-min-uuid. This covers WorkOrder, customer care, operations queue, inspection, appointment, payment, settlement and audit flows end-to-end over HTTP (supertest) on PG 16.

## 5. GO / NO-GO matrix

| # | Gate | Status | Evidence / action |
|---|---|---|---|
| G1 | Repo baseline + build | **GO** | §3 |
| G2 | 434 migrations on PG 16 + ledger + interrupted-index recovery | **GO** | §3, CR-HM-DB-OPT-02 S1–S4, recovery test |
| G3 | UUID fix + mobile feed contract (RBAC/isolation/empty) | **GO** | §4 smoke 20/20 + regression 6/6 |
| G4 | Key flows (WO/care/queue/inspection/appointment/payment/settlement/audit) | **GO** | §4 battery 181/181 |
| G5 | Pool/SSL/private URL/graceful shutdown | **GO** | §3, CR-HM-DB-OPT-02 R1–R6 |
| G6 | Live staging health + PG major = 16 | **GATED** | runbook §6 steps 1–2 (needs Railway access) |
| G7 | Live staging feed + key-flow smoke incl. `min(uuid)` absence in logs | **GATED** | runbook §6 steps 3–6 |
| G8 | Live p50/p95, pool vs plan `max_connections`, worker/backlog, log review | **GATED** | runbook §6 step 7–8; budget §2 |
| G9 | Backup + restore drill on staging | **GATED** | runbook §3 |
| G10 | Test debt preserved (5 stale snapshot/scan tests) | **GO** | §6 — unchanged, assertions intact |
| G11 | PgBouncer transaction pooling disabled | **GO** | §3 (session advisory locks) |
| G12 | No production changes | **GO** | nothing deployed/created/altered |

**Decision:** CONDITIONAL GO → deploy the current release artifact to **staging**, execute runbook §6–§7, then re-issue GO/NO-GO on G6–G9 live results before production.

## 6. Pre-existing test debt (independently tracked — unchanged, not disabled)

Re-run during this CR on PG 16: **exactly the same 5 failures** as recorded in `CR-HM-DB-OPT-02-VERIFICATION-REPORT.md` §7.1–7.5 (44 tests, 5 failing suites — assertions intact, no test file modified by this CR):

1. `tests/cr-be-fin-rpt-01-part04-payment-safety.test.ts` — era guard `0334 must not exist` vs later-added migration 0334.
2. `tests/handyman-customer-payments.test.ts` — firewall file-list drift (`available-actions.ts`).
3. `tests/handyman-lifecycle-api.test.ts` — OpenAPI 8-operation snapshot staleness.
4. `tests/handyman-payment-allocation.test.ts` — firewall source scan ('invoice' mention).
5. `tests/r10-part06-work-order-sla-contract.test.ts` — dataset-enum count 14 → 27.

Plus (test hygiene, separate): `tests/handyman-care-workspace-tenants.test.ts` self-collides on re-run against one DB (passes on first run — 12/12 in the fresh-DB battery).

## 7. Artifacts committed with this CR

- `scripts/db-bench/staging-smoke.ts` + `scripts/db-bench/out/staging-smoke.json` — rehearsal smoke/measurement harness + evidence (labeled NOT-live).
- `docs/change-requests/CR-HM-RAILWAY-STAGING-01-DBA-STAGING-RUNBOOK.md` — backup/restore, 0434 procedure + interrupted recovery, rollback, monitoring.
- This report.

No application source change was needed or made in this CR (no index/schema change; the measured evidence required no new justification for DDL).
