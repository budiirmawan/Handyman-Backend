# CR-HM-MOBILE-ASSIGN-UUID-01 — PostgreSQL 16 Mobile Assignment UUID Aggregate Compatibility

**Date:** 2026-10-13 · **Status:** COMPLETE · **Baseline:** `arena/6635d098-handyman-backend` @ `58b0706` (clean tree) · **Final HEAD:** see git log (`CR-HM-MOBILE-ASSIGN-UUID-01` commits)

## 1. Defect

`GET /api/v1/mobile/assignments` returned **HTTP 500** on PostgreSQL 16 (the deployed major) with:

```
function min(uuid) does not exist
```

- Source: `src/modules/mobile-assignments/mobile-assignment.service.ts` (`TASK_ASSIGNMENT_SELECT`, CR-BE-RN19-SAFETY-INSPECTION-01 lateral) — `CASE WHEN COUNT(*) = 1 THEN MIN(sib_row.id) ELSE NULL END` aggregates a **uuid**; PostgreSQL has no `min(uuid)`.
- Failure is at **parse time**, so every request with a workforce profile failed regardless of data. Introduced at base merge `edf26c8` (pre-existing; discovered during CR-HM-DB-OPT-02 verification and recorded there as §7.6).
- Reproduced deterministically on isolated PostgreSQL 16.14, both via raw SQL and via the endpoint (regression test red run: 4 feed tests 500'd with the exact error).

## 2. Intended aggregate semantics (verified, unchanged by the fix)

Per `toTaskItem` + the data-level guard `safety_inspection_bindings_schedule_active_unique` (partial unique: one ACTIVE binding per schedule definition):

| ACTIVE bindings for the task's schedule definition | `safetyInspectionBindingId` |
|---|---|
| 0 | `null` |
| exactly 1 | its id |
| >1 | unreachable via SQL inserts (unique guard); the service's `SAFETY_INSPECTION_BINDING_AMBIGUOUS` **409** remains as defense-in-depth above it |

Non-ACTIVE bindings never count. Only the task's own schedule definition is considered (strict company/property scope preserved). `MIN` over a single-element set is that element, so the projection is deterministic; for 0 and >1 rows the cardinality guard yields `NULL` — ordering never affects the outcome.

## 3. Fix (smallest correct change)

```sql
CASE WHEN COUNT(*) = 1 THEN MIN(sib_row.id::text)::uuid ELSE NULL END
```

One expression changed (`MIN(sib_row.id)` → `MIN(sib_row.id::text)::uuid`), matching the codebase's established pattern (`operational-variance.repository.ts`, `utility-aggregation.repository.ts`). A repo-wide scan confirmed this was the **only** uncast uuid aggregate in `src/`; no unrelated UUID operations were touched. **All 434 migrations untouched; no schema/index change.**

## 4. Verification (isolated PostgreSQL 16.14)

**Regression test** `tests/mobile-assign-uuid-01-min-uuid.test.ts` (6/6 green; red pre-fix):
- reproduces `min(uuid)` parse error and pins the fixed form's NULL/id/NULL semantics for 0/1/2-row sets (VALUES-based) and on the real table (INACTIVE ignored; second ACTIVE rejected by the partial unique guard);
- endpoint returns 200 with the marker per cardinality (was 500);
- company/property isolation: cross-company task + its binding never leak and never break the feed;
- empty case (scoped user, no assignments) → `200 []`;
- filtering surface: `?page=&pageSize=` pagination, `?shift=current` (200), invalid `?shift` (400);
- RBAC: anonymous 401, missing `task.read`/`work_order.read` 403.

**Focused neighbor battery** (serial, fresh PG 16 DB): **83/83 green** — `mobile-assignment-contract`, `mobile-assignment-shift-context`, `mobile-work-order-contract`, `work-order-completion` (previously 11/12 with the `min(uuid)` failure — now fully green), `work-order-action`, `work-order-bast-closure-part04`.

**TypeScript:** `npm run typecheck` (tsc --noEmit) clean · **Build:** `npm run build` (tsc) clean.

**Actual API response sample** (one ACTIVE binding; from the test run):

```json
{"id":"5feb6ccf-25f7-4591-893c-760d7a8bcc03","type":"TASK","status":"OPEN","assignee":{"assigneeType":"WORKFORCE","workforceProfileId":"01a3be34-69eb-4316-97f0-3c22c6aabf1d","teamId":null,"assignedByUserId":"a9f28087-5dbc-471b-8e9a-4c275f02f6e2","assignedAt":"2026-10-13T15:28:47.567Z","assignmentStatus":"ACTIVE"},"context":{"clientId":"78f929c7-df82-47e3-a5a4-3a42c7f9e05b","buildingId":"c42dc22e-9aba-40bf-8c4c-73fead54cefd","buildingCode":"U01_A_BLD_C0EC64F2","buildingName":"U01_A Building","locations":[]},"schedule":{"occurrenceAt":"2026-08-01T01:00:00.000Z","dueAt":null},"reference":{"taskId":"bdfd5c19-92dd-4b77-a46a-10a1bfa92649","scheduleDefinitionId":"b46974f2-ff71-42f6-b2cc-e4e2d17c8327","targetType":"CHECKLIST_TEMPLATE","targetId":"b46974f2-ff71-42f6-b2cc-e4e2d17c8327","generatedAt":"2026-10-13T15:28:47.564Z","utilityReadingDueId":null,"cleaningAreaId":null,"patrolExecutionId":null,"safetyInspectionBindingId":"2c2c2ba4-03b5-4dd7-8dab-f418f2e604c6","workOrderId":null,"workOrderNumber":null,"title":null,"description":null,"workType":null,"priority":null,"startedAt":null,"completedAt":null,"completedByUserId":null,"completionSummary":null,"completionNotes":null,"createdAt":null},"availableActions":["START","CANCEL"],"shift":null}
```

## 5. Pre-existing test debt (unchanged, not weakened)

The five pre-existing stale-assertion failures from CR-HM-DB-OPT-02 §7.1–7.5 remain recorded as **test debt** and were neither edited nor deleted: `cr-be-fin-rpt-01-part04-payment-safety` (0334-era guard), `handyman-customer-payments` (firewall file-list), `handyman-lifecycle-api` (OpenAPI snapshot), `handyman-payment-allocation` (firewall source scan), `r10-part06-work-order-sla-contract` (dataset-enum snapshot). None involve this CR's change. (CR-HM-DB-OPT-02 §7.7 care-workspace re-run hygiene also remains open.)

## 6. Remaining Railway staging gates (pre-release checklist)

1. Staging smoke: `GET /api/v1/mobile/assignments` returns 200 on Railway PG with real data (this defect 500'd unconditionally — highest-value smoke).
2. CR-HM-DB-OPT-01 runbook gates still apply: 0434 migrate on staging (invalid-index refusal + §3 recovery on failure), Q1/Q2 `EXPLAIN` spot-checks vs OPT-01 baselines, pool utilization within `instances × DB_POOL_MAX + workers × 1` budget.
3. PgBouncer **transaction pooling stays disabled** (session advisory locks, CR-HM-DB-OPT-02 §5).
4. Rollback: revert release; DB change is none (SQL-only patch), so no DB rollback action exists or is needed.
