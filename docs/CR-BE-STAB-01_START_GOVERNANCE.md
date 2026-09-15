# CR-BE-STAB-01 — START GOVERNANCE

**Title:** Fix production-critical corrective-action / incident-closure / scheduler defects (POST-BACKEND FEATURE GAP AUDIT)

**Status:** **Implemented** across PART 01–04 (governance analysis below; final validation in the merge PR). PART 01 restored the `CORRECTIVE_ACTION` review target; PART 02 proved the verification→VERIFIED→closure chain; PART 03 added an idempotent due reminder/escalation dispatcher; PART 04 wired the scheduler into runtime boot with graceful shutdown.

**Owner scope:** Corrective-action review-target compatibility, corrective-action verification runtime, incident closure dependency on verified corrective action, scheduler runtime invocation for existing reminder/escalation/expiry flows.

**Explicitly OUT of scope:** redesigning the review architecture, unrelated capabilities, Notification / Security Reports / frontend / mobile modules, TEST-DEBT.

---

## 0. Executive summary

The POST-BACKEND FEATURE GAP AUDIT surfaced four production-critical workflow defects. Investigation confirms all four are **live** on the current migration set and current `main`:

1. **`CORRECTIVE_ACTION` review-target regression** — migration `0232_add_document_approval_target` re-declared `reviews.review_target` and **silently dropped the `CORRECTIVE_ACTION` value** that `0222_add_corrective_action_verification` had added. This is the exact class of regression that `0213` was written to prevent; `0232` violates the `0213` forward rule.
2. **Corrective-action verification runtime failure** — `corrective_action_verification.repository.createPending` inserts `target_type = 'CORRECTIVE_ACTION'` into `reviews`, which now violates the DB `review_target` CHECK constraint → the verification cannot be opened, so it can never be submitted or completed.
3. **Incident-closure dependency chain** — closure of a REPORTED Incident is blocked unless every required corrective action is `VERIFIED`; `VERIFIED` is reachable only through a completed verification; and verification is unreachable due to (2). Therefore **any Incident requiring a corrective action can never be closed** end-to-end.
4. **Scheduler runtime invocation** — reminder (`notification-reminders`), escalation (`notification-escalations`) and document-expiry flows define read/due seams (`findDueReminders`, `dispatchDueReminders`, `findDueEscalations`, `triggerDueEscalations`) but **no scheduler engine or worker exists**; the HTTP server boots no background loop and `package.json` declares no cron/queue dependency. Nothing invokes these flows on a timer.

---

## 1. Root cause

### 1.1 CORRECTIVE_ACTION review-target compatibility (scope 1)

`reviews.review_target` is an `IN (...)` CHECK constraint that has been re-declared many times. Each re-declaration historically restated a *subset* it believed current instead of adding to the union — the regression `0213` documented and fixed for `FINDING`.

- `0222_add_corrective_action_verification` (BE-21J) **additively** added `'CORRECTIVE_ACTION'` to the union (per the `0213` forward rule) and created the partial unique index `corrective_action_pending_review_unique`.
- `0232_add_document_approval_target` (BE-22I, later in the array) re-declared the constraint from scratch and **omitted `'CORRECTIVE_ACTION'`**:
  `FORM_INSTANCE, CHECKLIST_EXECUTION, WORK_ORDER, FINDING, VENDOR_WORK, UTILITY_ABNORMAL_CONSUMPTION, PERMIT_APPLICATION, DOCUMENT, DOCUMENT_VERSION`.

Because `migrateUp` applies the full ordered list (`src/database/migrate.ts` iterates `migrations`), the **final effective** constraint on any fresh database is `0232`'s — which rejects `CORRECTIVE_ACTION`. This is the same defective pattern `0213` was created to eliminate; the forward rule was violated by a later, unrelated feature migration.

### 1.2 Corrective-action verification runtime failure (scope 2)

Failure chain, all in the `corrective-action-verifications` module:

1. `corrective-action-verification.repository.createPending` executes `INSERT INTO reviews ... VALUES ($1, $2, 'CORRECTIVE_ACTION', $3, ...)`.
2. The `review_target` CHECK constraint (final state from §1.1) does **not** admit `'CORRECTIVE_ACTION'` → Postgres raises a **check-constraint violation (SQLSTATE `23514`)**.
3. `openVerification` in the service catches only the **pending-unique** violation (`23505` / `corrective_action_pending_review_unique`); a `23514` is **not handled** and propagates as an unhandled 500.
4. Because the PENDING row is never created, `submitVerification` can never run, `complete` never executes, and `correctiveActionRepository.markVerified` / `returnToProgress` are never reached. The `VERIFIED` lifecycle state added by `0222` is therefore **structurally unreachable**.

The affected `corrective_actions` schema (VERIFIED status, `verified_at`, `verified_by_user_id`, the three relaxed CHECK constraints from `0222`) is present and valid; it is simply never exercised.

### 1.3 Incident closure dependency on verified corrective action (scope 3)

Closure rules (`incident-closure.rules.ts`) block closure of a REPORTED Incident when:
- `requiredActionCount === 0` → `NO_CORRECTIVE_ACTION`;
- `unresolvedActionCount > 0`, `reworkRequiredCount > 0`, `rejectedVerificationCount > 0`, `pendingVerificationCount > 0`;
- **`unverifiedActionCount` exceeds the pending/rework/rejected counts** → `CORRECTIVE_ACTION_UNVERIFIED`.

`incident-closure.repository.findFactsByIncidentId` derives `verified` as `COUNT ... WHERE ca.status = 'VERIFIED'`, and reads the latest decisions from `reviews` filtered on `target_type = 'CORRECTIVE_ACTION'`. Combined with §1.2:

> An Incident that records any required corrective action can **never** accumulate a `VERIFIED` action, so **every such Incident is permanently uncloseable**. This is the production-critical consequence of the `0232` regression.

`closeIncident` (service) does enforce `evaluateClosureBlockers` before calling `incidentRepository.closeReported`, so this is not a bypass — it is a hard dead-end.

### 1.4 Scheduler runtime invocation (scope 4)

- `src/app.ts` / `src/server.ts` build the Express app and listen; **no background job loop is started**.
- No `setInterval` / `setTimeout` / cron / queue / worker exists anywhere in `src/` (grep confirms none; no scheduler module directory; `package.json` has no `node-cron`, `bull`, `agenda`, `bree`, etc.).
- The flows implement **durable "scheduler seams"** (explicitly documented in code as "NO scheduler engine"):
  - `notification-reminders`: `findDueReminders`, `dispatchReminder`, `dispatchDueReminders` (service).
  - `notification-escalations`: `findDueEscalations`, `triggerEscalation`, `triggerDueEscalations` (service).
  - `document-expiry`: state is **read-time derived** (`resolveExpiryState` on GET) — no due-scan seam exists; expiry is not timer-driven by design.
- The HTTP routes deliberately expose **no** trigger/dispatch endpoint (`*scheduler engine is exposed*` comments), so there is no way to invoke the seams except by directly calling the service (only tests do). Hence due reminders/escalations are **never dispatched in production**; expiry notifications (if intended) have no timer at all.

**Core root cause for scope 4:** the seams were built but the **runtime invocation (a scheduler/worker) was never implemented or wired into process startup**.

---

## 2. Exact affected files

### Migrations / schema
| File | Role |
|---|---|
| `src/database/migrations/0222_add_corrective_action_verification.ts` | Adds `CORRECTIVE_ACTION` target + `VERIFIED` status/metadata + partial unique index (its intent is broken by 0232). |
| `src/database/migrations/0232_add_document_approval_target.ts` | **ROOT-CAUSE migration**: re-declares `review_target` and drops `'CORRECTIVE_ACTION'`. |
| `src/database/migrations/0213_restore_review_target_union.ts` | Exports `REVIEW_TARGET_UNION` referenced by 0222; documents the forward rule that 0232 violated. |
| `src/database/migrations/index.ts` | Ordered migration list (ordering makes 0232 the final word on `review_target`). |
| `src/database/migrate.ts` | Applies the full ordered migration set. |

**Schema impact:** `reviews.review_target` CHECK (final, post-0232) excludes `CORRECTIVE_ACTION`; `corrective_actions.*` (VERIFIED state + `verified_at`/`verified_by_user_id`) exist but are unreachable; `corrective_action_pending_review_unique` index exists but can never be populated.

### Services / routes / controllers
| Module | Files |
|---|---|
| Corrective action verification | `corrective-action-verification.service.ts`, `.repository.ts` (`createPending` INSERT), `.controller.ts`, `.routes.ts`, `.types.ts`, `.errors.ts` |
| Corrective actions | `corrective-action.repository.ts` (`markVerified`/`returnToProgress`), `.service.ts`, `.controller.ts`, `.routes.ts` |
| Incident closure | `incident-closure.rules.ts`, `incident-closure.service.ts` (`closeIncident` gating), `incident-closure.repository.ts` (VERIFIED counts / `reviews` join), `.controller.ts`, `.routes.ts`, `.types.ts` |
| Notification reminders (scheduler seam) | `notification-reminder.service.ts` (`findDueReminders`, `dispatchReminder`, `dispatchDueReminders`), `.repository.ts` |
| Notification escalations (scheduler seam) | `notification-escalation.service.ts` (`findDueEscalations`, `triggerEscalation`, `triggerDueEscalations`), `.repository.ts` |
| Document expiry | `document-expiry.service.ts` (read-time `resolveExpiryState`; no job) |
| Bootstrap | `src/app.ts`, `src/server.ts` (no scheduler/worker boot) |
| Routing registration | `src/routes/index.ts` (reminder/escalation routers registered; no scheduler route) |

### Tests (validation targets, NOT to be modified for TEST-DEBT in this CR)
`tests/corrective-action-verifications.test.ts`, `tests/incident-closure.test.ts`, `tests/corrective-actions.test.ts`, `tests/corrective-action-due-dates.test.ts`, `tests/corrective-action-responsibilities.test.ts`, `tests/operational-incidents.test.ts` (all run `migrateUp` → all currently exercise the defective final constraint).

---

## 3. Database / migration impact

- **Existing deployed DBs** that already ran `0232` (and not a later fix): `review_target` currently rejects `CORRECTIVE_ACTION`. No data is corrupt; corrective-action verification rows were never insertable, so there is no orphaned `reviews` data to clean. The `corrective_actions` table may already hold `COMPLETED` actions awaiting verification — those become verifiable once the constraint is fixed.
- **Fix shape (safe, additive):** one new migration that **adds** `'CORRECTIVE_ACTION'` to the union (never restates a subset), preserving `DOCUMENT`/`DOCUMENT_VERSION` and all prior values. Must follow the `0213` forward rule.
- **Precedents to reuse:** `0213_restore_review_target_union` (additive re-declaration) and the `REVIEW_TARGET_UNION` constant, so a fix can import a single canonical list. `down` should be destructive-restore convention (as in 0095/0211/0213/0222) — delete `CORRECTIVE_ACTION` reviews before reverting.
- **No new table** is required. Verification remains on the shared `reviews` table (governance rule: no second source of truth for "was this verified").
- Scope 4 (scheduler) is **non-migratory** — no schema change; runtime invocation only.

---

## 4. Runtime dependency chain

```
corrective-action-verification.service.openVerification
  → verification.repository.createPending
      → INSERT reviews (target_type='CORRECTIVE_ACTION', status='PENDING')
          → DB review_target CHECK ⇒ 23514 FAILURE  (root: migration 0232)
              ↓ (never reaches)
  → verification.repository.complete
      → corrective-action.repository.markVerified  (status='VERIFIED')
      → corrective-action.repository.returnToProgress (rework)

incident-closure.service.closeIncident
  → evaluateClosureBlockers(facts)
      → incident-closure.repository.findFactsByIncidentId
          → COUNT(ca.status='VERIFIED') from corrective_actions
          → latest decisions from reviews WHERE target_type='CORRECTIVE_ACTION'
  → requires verifiedActionCount == requiredActionCount
      ⇒ blocked forever (VERIFIED unreachable) ⇒ INCIDENT CANNOT CLOSE

scheduler seam (no runtime):
  server.ts/app.ts boot → (no scheduler start)
  notification-reminders.findDueReminders/dispatchDueReminders  → never invoked on a timer
  notification-escalations.findDueEscalations/triggerDueEscalations → never invoked on a timer
  document-expiry → read-time derived only
```

---

## 5. Backward-compatibility risks

1. **`reviews` constraint change is additive-only.** Adding `CORRECTIVE_ACTION` cannot invalidate any existing row (all current values remain valid). Risk is minimal and confined to the CHECK constraint.
2. **Verification rows may already exist in unusual cases** (e.g. a DB where `0232` was applied then manually reverted, or a partial deploy). The fix migration must handle/honor the existing `corrective_action_pending_review_unique` index and not conflict with it.
3. **`down` semantics** must mirror the destructive-restore convention to keep migrations a true inverse.
4. **Scheduler runtime addition** must be **opt-in / side-effect-safe and idempotent**:
   - Dispatch seams are already idempotent (`markSent`/guarded `UPDATE ... WHERE status='PENDING'`), so a scheduler loop is safe to run repeatedly.
   - Must not dispatch in test environment, must not change request-path behavior, must not break the existing HTTP-only process model. Prefer an **optional, separately-invoked worker** (e.g. a startup-guarded loop or a `--worker` process entrypoint) rather than a mandatory thread inside the API process, to avoid coupling API availability to scheduler DB writes.
   - Must respect `NODE_ENV=test` and existing config/env flags.
5. **Do not touch** Notification, Security Reports, frontend, mobile, or TEST-DEBT per scope.

---

## 6. Proposed minimal solution (conceptual — NOT implemented here)

**Part A — restore the review target union (scopes 1, 2, 3).**
One additive migration (new id after `0285`, e.g. `0286_add_corrective_action_review_target`) that:
- imports `REVIEW_TARGET_UNION` from `0213`,
- re-declares `review_target` as `REVIEW_TARGET_UNION + 'CORRECTIVE_ACTION' + 'DOCUMENT' + 'DOCUMENT_VERSION'` (i.e. current final union **plus** the missing value),
- leaves `corrective_actions`, the VERIFIED status, `verified_at`/`verified_by_user_id`, and `corrective_action_pending_review_unique` untouched (they are already correct),
- provides a destructive-restore `down`.
No application code change is required for scopes 1–3 — the verification and closure modules are already correct once the constraint admits `CORRECTIVE_ACTION`.

**Part B — wire scheduler runtime invocation (scope 4).**
Add an optional, idempotent background dispatcher (no new table, no schema change) that invokes the existing seams on a cadence:
- `notificationReminderService.dispatchDueReminders()`,
- `notificationEscalationService.triggerDueEscalations()`,
- (expiry: leave read-time derivation as-is; only add a timer if expiry *notifications* are an intended flow — confirm before adding).
Guard behind a config/env flag and skip in `NODE_ENV=test`. Invoke from `server.ts` startup (or a separate `worker` entrypoint) with interval + graceful shutdown. Reuse the already-idempotent dispatch guards.

No changes to Notification domain behavior, Security Reports, frontend, or mobile. No TEST-DEBT remediation.

---

## 7. Implementation PART breakdown (small, Arena-sized)

| PART | Scope | Change | Risk |
|---|---|---|---|
| **PART 01** | Scope 1/2/3 | New additive migration `0286_...` restoring `CORRECTIVE_ACTION` in `review_target` + `down`; register in `migrations/index.ts`. | Low; purely schema. |
| **PART 02** | Scope 1/2/3 | Add a targeted integration test proving open→submit→VERIFIED on a full migrated DB (verification + closure reachable end-to-end). *(Validation, not TEST-DEBT — must land to prove the fix.)* | Low. |
| **PART 03** | Scope 4 | Introduce an optional idempotent dispatcher module invoking reminder/escalation seams, gated by env flag and skipped in test. | Medium; runtime + process boot. |
| **PART 04** | Scope 4 | Wire dispatcher into `server.ts` startup (or separate worker entrypoint) with interval + graceful shutdown on SIGTERM/SIGINT. | Medium. |

Each PART is independently reviewable and reversible.

---

## 8. Validation strategy

1. **Schema state check:** run full `migrateUp` on a fresh test DB, then introspect `pg_get_constraintdef` for `review_target` and assert it contains `'CORRECTIVE_ACTION'`, `'FINDING'`, `'DOCUMENT'`, `'DOCUMENT_VERSION'`.
2. **E2E corrective-action verification (PART 02):** under a REPORTED Incident, complete an action, open a verification (must succeed — previously 23514), submit `APPROVED`, assert action → `VERIFIED` and event logged; re-run to assert finality/immutability.
3. **E2E incident closure:** with all required actions `VERIFIED`, assert `closeable=true` and `closeReported` succeeds; assert `CORRECTIVE_ACTION_UNVERIFIED` blocker returns when an action is `COMPLETED`-but-unverified.
4. **Regression on other targets:** confirm `FINDING`, `WORK_ORDER`, `VENDOR_WORK`, `UTILITY_ABNORMAL_CONSUMPTION`, `PERMIT_APPLICATION`, `DOCUMENT` verification paths still pass (existing suites).
5. **Scheduler (PART 03/04):** unit-call `dispatchDueReminders` / `triggerDueEscalations` against seeded PENDING rows (idempotent on repeat); integration: start worker, assert due rows transition SENT/triggered and non-due rows untouched; assert worker no-ops under `NODE_ENV=test` and during shutdown.
6. **Full suite:** `npm test` (all existing suites green) and `npm run typecheck`.

---

## Implementation status (PART 01–04)

| PART | Deliverable | Status |
|---|---|---|
| PART 01 | Additive migration `0286_add_corrective_action_review_target` restoring `CORRECTIVE_ACTION` (registers in `migrations/index.ts`); focused regression test. | Implemented |
| PART 02 | E2E regression `cr-be-stab-01-verification-closure-chain.test.ts` proving create→PENDING→VERIFIED→close. | Implemented |
| PART 03 | `src/modules/due-job-dispatcher/` — idempotent caller of `findDueReminders`/`dispatchReminder` and `findDueEscalations`/`triggerEscalation`; focused test. | Implemented |
| PART 04 | `src/modules/due-job-scheduler/` + `SchedulerConfig` (`SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`) + `server.ts` boot wiring & graceful shutdown; focused test. | Implemented |

No production domain logic (notification, reminder, escalation, Corrective Action, Incident, document-expiry) was modified. Scheduler is disabled by default in dev and always in `NODE_ENV=test`; enabled by default in production at a conservative 60s cadence.
