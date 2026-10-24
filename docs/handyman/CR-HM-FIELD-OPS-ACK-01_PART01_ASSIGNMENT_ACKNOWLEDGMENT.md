# CR-HM-FIELD-OPS-ACK-01 — PART 01: Assignment Acknowledgment

- **Contract:** HANDYMAN FIELD OPERATIONS CONTRACT — PART 01
- **Repository:** `budiirmawan/Handyman-Backend` (only repository touched)
- **Branch:** `arena/a61abf59-handyman-backend`
- **Baseline:** `ee20d2183f8191c4718d0755658b4f7c3739bbf9` — `Merge pull request #58 from budiirmawan/arena/6b721660-handyman-backend` (Notification Engine preserved)
- **No Biznet / production deployment. No PR opened in this PART.**

---

## 1. Inspection first — what already existed on `main` (including PR #58)

The three authoritative assignment lanes and the PR #58 notification engine were inspected before any code was written. Existing code was **reused, not rebuilt**.

| Contract capability | Pre-existing authority found | Verdict before PART 01 |
| --- | --- | --- |
| Worker accept / reject | `POST /work-orders/:id/assignments/:assignmentId/respond`, `POST /handyman/execution-scopes/:executionScopeId/assignments/:assignmentId/respond`, `POST /handyman/visit-appointments/:visitAppointmentId/inspector-assignments/:assignmentId/respond` (migration `0472`, services `respondToWorkOrderAssignment`, `respondToHandymanExecutionScopeAssignment`, `respondToInspectorVisitAssignment`) | **EXISTS.** Reused as-is. |
| Assignment state machine | `PENDING → TERIMA \| TIDAK_BISA`; terminal-immutable + no-delete + append-only event triggers in `0472` | **EXISTS.** Untouched. |
| Field permissions | `work_order.read` for the Work Order lane; authenticated current Crew Lead / assigned Inspector ownership + exact-Building scope for the two Handyman lanes. Mobile workers never hold `work_order.manage` / `tenant_company.manage`. | **EXISTS.** Reused. |
| Reassignment guards | superseded/inactive/revoked assignments rejected with `409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED` / `WORK_ORDER_ASSIGNMENT_SUPERSEDED`; `ASSIGNMENT_SUPERSEDED` event preserves the old decision | **EXISTS.** Reused; covered again by new negative tests. |
| Concurrency serialization | `SELECT … FOR UPDATE` on the parent scope / visit / work order and on the assignment row, inside `withTransaction`; `UNIQUE (assignment_target_type, assignment_id)` on the response row | **EXISTS.** Reused; new key guard adds the missing cross-assignment layer. |
| Notification engine (PR #58) | `handyman-assignment-notification-producer.service.ts` — 12 assignment events, one producer seam, deduplicated IN_APP + durable outbound intents | **PRESERVED.** Zero edits to `src/modules/handyman-notifications/**`, `notification-*` transports, or push adapters. |
| Assignment audit history | `handyman_assignment_response_events` + `GET .../response-history` on all three lanes; Work Order `TERIMA` also writes `ACKNOWLEDGED` into `work_order_actions` + `operational_events` | **PARTIAL.** Handyman lanes had the decision ledger but no explicit acknowledgment event on the shared BE-07 operational event store. |
| My Jobs feed | `MY_JOBS_SQL` / `MY_INSPECTIONS_SQL` in `handyman-field-feed.service.ts` | **PARTIAL.** The SQL selected `a.id AS "assignmentId"`, but the authorized feed authority suite (`tests/handyman-field-feed-authority.test.ts`) was **broken on the baseline** — its TEMP fixtures lacked `handyman_assignment_responses`, `handyman_work_sessions`, `handyman_dispatch_releases`, `handyman_inspector_assignments` and the assignment `id`/`version` columns. 14/14 feed assertions aborted with `42P01 relation "handyman_assignment_responses" does not exist`. No executed assertion proved the `assignmentId` contract. |
| Concurrent-device idempotency | identical decision replay returns `200 idempotentReplay: true`; conflicting decisions → `409` | **PARTIAL.** The two Handyman `/respond` validators silently ignored a caller `idempotencyKey`; no server fact bound a device key to an actor+assignment, so an offline replay could finalize a **replacement** assignment without detection. |
| Expiry guards | lifecycle "late" guards (work session started, visit completed, Work Order terminal) | **MISSING.** No authoritative appointment-window expiry fact was consulted anywhere in the response path. |

### Confirmed missing capabilities implemented in this PART

1. `assignmentId` (plus `assignmentTargetType`, `assignmentVersion`, `assignedAt`, `acknowledgedAt`) in the **authorized** My Jobs / My Inspections feed, with a working authority suite and negative tenant/crew cases.
2. Explicit acknowledgment + audit trail on the two Handyman lanes (`HANDYMAN_ASSIGNMENT_ACKNOWLEDGED` / `HANDYMAN_ASSIGNMENT_DECLINED` on `operational_events`) and `acknowledgedAt` / `acknowledgedByUserId` in the response views and history projection.
3. Concurrent-device idempotency: optional `Idempotency-Key` header (preferred) or legacy `idempotencyKey` body member on all three `/respond` routes; one actor + one key may finalize **one** assignment, enforced in the application and by a partial UNIQUE index. Identical decisions from different devices still converge on one decision event and one audit row.
4. Appointment-window expiry guard (`409 HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED`) on the Handyman lanes, evaluated AFTER the identical-replay check so device replays stay idempotent; reassignment stays an Operations remedy.
5. Tenant/crew scope hardening in the feed SQL (response projection and inspector assignment now bound to the visit's client/building) plus focused negative RBAC tests.

---

## 2. Decisions (bounded; no new business authority invented)

- **D-1 — The expiry fact comes from an existing authority, never a new clock.** `INSPECTOR_VISIT_ASSIGNMENT` uses the inspection visit's own immutable `end_at`. `EXECUTION_SCOPE_ASSIGNMENT` uses the `end_at` of the `CONFIRMED` / `IN_PROGRESS` EXECUTION appointment bound to the **same scope AND the assignment's crew**. An unscheduled scope has NO expiry fact: the existing lifecycle late guard remains its only gate. The Standard Work Order lane has no Handyman appointment authority, so its existing Work Order-status late guard remains the sole gate. The server clock (`NOW()`) is authoritative; a client cannot back-date an acknowledgment.
- **D-2 — Reassignment is the remedy, not an exception.** The expiry guard blocks only the worker response. Operations can still reassign; the replacement assignment is bound by the same window. Superseded/revoked assignments keep the pre-existing `409 …_SUPERSEDED`.
- **D-3 — Idempotency key scope = actor × key × ONE assignment.** Replaying the same key on the **same** assignment is still governed by the pre-existing identical/conflicting decision rules. Replaying it on a **different** assignment (e.g. an offline device after reassignment) is refused with `409 HANDYMAN_ASSIGNMENT_RESPONSE_IDEMPOTENCY_CONFLICT`. A fresh key is never locked out. Raw keys are never placed in audit metadata (only `clientKeyProvided: boolean`).
- **D-4 — The internal `idempotency_key` column is unchanged.** A new nullable `client_idempotency_key` column (migration `0476`) carries the device key, so the `0472` deterministic per-assignment event key keeps working and an in-place upgrade never has to deduplicate historical rows (legacy rows stay `NULL`).
- **D-5 — No new endpoints.** Only existing routes gained an optional parameter/body member, so the frozen 287-operation Handyman surface and the CR-HM-BACKEND-CONTRACT-FREEZE-03 runtime parity hold.

### Arrival challenge — NOT in this PART

`CREATE_ARRIVAL_CHALLENGE` remains an available action in the feed but **no arrival-challenge, QR, geofence, token or verification code was added or modified**. `src/modules/handyman-arrival-challenges/**`, `handyman-arrival-locations/**`, `handyman-arrival-results/**` and `handyman-arrival-verification-api/**` are untouched.

---

## 3. Implementation map

| File | Change |
| --- | --- |
| `src/database/migrations/0476_handyman_assignment_response_client_keys.ts` (new) | Additive `client_idempotency_key TEXT`, CHECK (only on finalized rows, 8–128 trimmed chars, actor present), partial UNIQUE index `(responded_by_user_id, client_idempotency_key)`; idempotent up/down. |
| `src/database/migrations/index.ts` | Registers `0476` after `0475`. |
| `src/modules/assignment-responses/assignment-response.{types,repository}.ts` | New field mapping, `recordDecision` writes it, `findFinalizedByClientKey(actor, key)`. |
| `src/modules/assignment-responses/assignment-response.errors.ts` | `handymanAssignmentResponseExpiredError`, `handymanAssignmentResponseIdempotencyConflictError`. |
| `src/modules/assignment-responses/assignment-response.guards.ts` (new) | Bounded key normalization, `assertClientKeyAvailableForAssignment`, `assertAssignmentResponseWindowOpen`. |
| `src/modules/assignment-responses/assignment-response.validation.ts` (new) | Header-over-body parser (8–128 chars). |
| `src/modules/assignment-responses/index.ts` | Re-exports only. |
| `src/shared/errors.ts` | Two additive error codes. |
| `src/modules/handyman-scope-assignments/**`, `handyman-inspector-assignments/**` | Key + expiry guards inside the existing locked transaction (after replay, before the mutation), BE-07 acknowledgment/decline event, `acknowledgedAt` in response + history views. |
| `src/modules/work-order-assignments/**` | Same actor×key guard; existing `ACKNOWLEDGED` action / SLA / operational-event integration untouched. |
| `*-api.controller.ts` (three lanes) | Reads the optional `Idempotency-Key` header; actor still comes only from `req.auth`. |
| `src/modules/handyman-field-feed/handyman-field-feed.service.ts` | Projects `assignmentId`, `assignmentTargetType`, `assignmentVersion`, `assignedAt`, `acknowledgedAt`; binds the response projection to the scope/visit client+building and the inspector assignment to the visit client+request. |
| `docs/api/openapi.yaml` | Optional `AssignmentResponseIdempotencyKey` header on the three respond operations, new error codes, `idempotencyKey` in the two request schemas, acknowledgment fields in the response/history schemas. |

---

## 4. Test evidence (focused only — no full suite)

```text
npx tsc --noEmit                                                     → PASS (0 errors)

tests/handyman-field-ops-ack-part01.test.ts                         →  5 / 5   PASS
tests/handyman-field-feed-authority.test.ts                         → 22 / 22  PASS  (was 14 FAIL on baseline)
tests/handyman-field-feed-contract.test.ts                          →  4 / 4   PASS
tests/handyman-assignment-response-part02a.test.ts                  →  8 / 8   PASS
tests/handyman-assignment-response-part02b.test.ts                  →  5 / 5   PASS
tests/handyman-assignment-response-part02c.test.ts                  →  6 / 6   PASS
tests/handyman-notification-producer-part01.test.ts                 →  3 / 3   PASS  (PR #58)
tests/handyman-multiclient-notification-certification.test.ts       →  7 / 7   PASS  (PR #58)
tests/handyman-contract-freeze-03-openapi.test.ts                   → 13 / 13  PASS
tests/openapi-contract.test.ts + mobile-openapi-completeness
  + mobile-push-delivery-boundary-contract                          → 41 / 41  PASS  (combined batch)
```

`tests/handyman-field-feed-authority.test.ts` was repaired, not weakened: its stale pre-R1C assertion “PROPOSED inspections are absent” was corrected to the **frozen R1C contract** (PROPOSED / TENANT_SELECTED inspections ARE work-queue items; only the EXECUTION job stays unbooked) — the SQL and `tests/handyman-field-feed-contract.test.ts` already said so.

### Baseline-identical non-PASS (documented, not relabelled)

`tests/mobile-assignment-contract.test.ts` reports **13 failures / 18 tests** both with and without this PART. It was reproduced on the untouched baseline by stashing this PART's whole working tree (`git stash push -u`), running the suite alone, then restoring (`git stash pop`): identical `401 !== 200` / `database pool is not initialized` failures. This is the pre-existing BE-25C mobile-assignment bootstrap debt already recorded in `CR-HM-MULTICLIENT-NOTIFICATION-01_RELEASE_DEBT_REGISTER.md`. **No assertion was weakened and no failure was relabelled as a pass.** It is out of scope for this PART (no second feed engine, no new route).

---

## 5. Mobile / frontend handoff (additive)

`GET /api/v1/handyman/field/my-jobs` now returns, per item:

```jsonc
{
  "jobs": [{
    "executionScopeId": "…", "requestId": "…", "buildingId": "…",
    "assignmentId": "…",                         // respond with THIS id, not the scope id
    "assignmentTargetType": "EXECUTION_SCOPE_ASSIGNMENT",
    "assignmentVersion": 1, "assignedAt": "…",
    "responseStatus": "PENDING", "acknowledgedAt": null,
    "reassignmentRequired": false, "availableActions": ["TERIMA", "TIDAK_BISA"]
  }],
  "inspections": [{
    "visitAppointmentId": "…", "requestId": "…",
    "assignmentId": "…",                         // respond with THIS id, not the visit id
    "assignmentTargetType": "INSPECTOR_VISIT_ASSIGNMENT",
    "assignmentVersion": 1, "assignedAt": "…",
    "responseStatus": "PENDING", "acknowledgedAt": null,
    "availableActions": ["TERIMA", "TIDAK_BISA"]
  }],
  "feedSource": "AUTHORITATIVE_BACKEND"
}
```

Send `Idempotency-Key: <8–128 chars>` from each device on `/respond`. Same decision from two devices → both `200`, one `idempotentReplay: false`, one `true`, exactly one event/notification. Conflicting decisions → one `200`, one `409`. Same key on a reassigned assignment → `409 HANDYMAN_ASSIGNMENT_RESPONSE_IDEMPOTENCY_CONFLICT`. A past appointment window → `409 HANDYMAN_ASSIGNMENT_RESPONSE_EXPIRED`; ask Operations to reschedule/reassign.

---

## 6. Explicit non-goals of PART 01

- ❌ Arrival challenge / QR / geofence / arrival verification (deferred).
- ❌ Any other repository (Frontend / BM / Mobile) — untouched.
- ❌ Biznet, Coolify or any production deployment, migration rollout or push activation.
- ❌ Full test suite (not requested); only the focused batches above were run.
- ❌ Pull request — reserved for FINAL REVIEW.
- ❌ Changes to the PR #58 Notification Engine, the 12 assignment events, the 18 domain producer call sites or the push transports.
