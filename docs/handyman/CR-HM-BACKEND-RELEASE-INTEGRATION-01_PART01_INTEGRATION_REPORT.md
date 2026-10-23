# CR-HM-BACKEND-RELEASE-INTEGRATION-01 — PART 01
# Integration & Release Candidate — INTEGRATION REPORT

**Status: PASS** (with 2 pre-existing defects repaired and 3 documented
environment limitations)

| Item | Value |
| --- | --- |
| Repository | `budiirmawan/Handyman-Backend` |
| Integration branch | `arena/44decf3c-handyman-backend` |
| Base | `main` @ `e8b94af426d5d730900d98716135a7114e62e097` |
| Target | ONE Handyman Backend release for Biznet Coolify |
| PR opened | **none** (intentionally withheld until FINAL REVIEW) |
| Merged / deployed | **no** (no PR, no merge to main, no deployment) |
| Production database touched | **no** (disposable PostgreSQL only) |

---

## A. Preflight — PASS

| Check | Result |
| --- | --- |
| `main` is the newest commit | `e8b94af` — no newer commits on `origin/main` |
| PR #55 branch | `arena/3df97f5e-handyman-backend` @ `30be708e6d723975f2909c76bde9259a231c7bce` ✔ |
| IAM revocation branch | `arena/37aa07d3-handyman-backend` @ `63f3a85159086d3fad68c8b88fdb7e14796922fa` ✔ |
| PR #56 branch | `arena/daf49406-handyman-backend` @ `8f549dc9be04d8eb67548dcc6ec1a4df89b52988` ✔ |
| Merge base of all three | `e8b94af` — **all three were 0 commits behind main** |
| Working tree before start | clean |
| Integration started from a clean branch off latest main | yes |
| Work done directly on `main`/production | never |

### Preflight commit inventory

| Source | Commits ahead of main |
| --- | --- |
| PR #55 | 14 (`1597ac5` … `30be708`) |
| IAM revocation | 1 (`63f3a85`) |
| PR #56 | 7 (`4a3bc7d` … `8f549dc`) |

No source commit was duplicated, replayed, or squashed away: each source was
integrated with `git merge --no-ff`, so every original commit is reachable and
`git log --graph` still shows the three release lines converging.

### PR #47 exclusion — PASS

`CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01` (PR #47, branch
`arena/6105302d-handyman-backend` @ `7ae15069`) was **not** merged. Verified:
`git diff main --stat | grep -iE "attestation|bank-receipt"` returns nothing.

---

## B. Integration order and conflict resolution — PASS

Merged strictly in the required order.

| # | Step | Merge commit | Conflicts |
| --- | --- | --- | --- |
| B1 | PR #55 — Worker Competency, Direct Workforce, Multi-Trade | `37cc6e0` | 0 (clean) |
| B2 | IAM Revocation — Permission Revocation | `515919f` | 1 (`migrations/index.ts`) |
| B3 | PR #56 — Expense, Helper Attendance, Assignment Response | `f75f84c` | 11 |

### Conflicts resolved — both sides preserved

| File | Resolution |
| --- | --- |
| `src/database/migrations/index.ts` | Union: `0461…0468` **and** `0470…0472` registered in numeric order. No `0469`. |
| `src/routes/index.ts` | Auto-merged; all five new routers mounted once (see C7). |
| `src/shared/errors.ts` | Union: workforce-certification + competency codes **and** `LAST_ADMIN_PERMISSION_REQUIRED` **and** the assignment-response codes. |
| `docs/api/openapi.yaml` | Three conflicts rebuilt from both sides: 287 Handyman operations, 1,532 paths, 2,312 schemas, **0 duplicate paths**, **0 duplicate operationIds**. |
| `src/modules/work-order-assignments/work-order-assignment.service.ts` | Rewritten as ONE service holding both authorities: classification/competency gate **and** the TERIMA/TIDAK_BISA response lifecycle. |
| `src/modules/work-order-assignments/work-order-assignment.types.ts` | `PublicWorkOrderAssignment` carries the response projection **and** the optional `competency` outcome. |
| `src/modules/work-order-assignments/work-order-assignment.controller.ts` | Union of 6 response/assignment handlers + `listCompetencyDecisionsHandler`. |
| `src/modules/work-order-assignments/work-order-assignment.routes.ts` | 7 routes, each registered exactly once; static segment before `:assignmentId`. |
| `src/modules/work-order-assignments/index.ts` | Both `respondToWorkOrderAssignment` and `revalidateActiveAssignmentForClassification` exported. |
| `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts` | PART 03A competency gate **and** the old-crew-lead lookup used by the supersede notification, both before the supersede write. |
| Notification / permission services | Auto-merged; verified by the permission-revocation and assignment-response suites (8/8, 8/8, 5/5, 6/6). |
| `MOBILE_API_HANDOFF.md` | Both handoff chapters kept; the second renumbered §8 so numbering stays unique. |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | Pins reconciled to the merged surface: 287 operations / 190 annotated, with the additive arithmetic documented inline (269 + 3 + 15 and 179 + 3 + 8). |

`src/modules/work-order-assignments/work-order-assignment.repository.ts`
auto-merged **correctly and completely**: it carries both PR #55's
`executor` parameter on every method and PR #56's `findByIdForUpdate` /
`findActiveByWorkOrderIdForUpdate`.

---

## C. Combined audit — PASS

### C1. Competency gate and assignment response in the SAME transaction — PASS

In `assignWorkOrder` the transaction now performs, in order:

1. `SELECT … FROM work_orders … FOR UPDATE`
2. `findActiveByWorkOrderIdForUpdate` (already-assigned guard)
3. `workOrderAssignmentRepository.create`
4. **`applyCompetencyGate`** (throws 409 on a MANDATORY gap)
5. `assignmentResponseRepository.ensurePendingForAssignment`
6. `recordWorkOrderEvent` (one event carrying **both** the competency summary and
   the response status)
7. `notifyWorkOrderAssignedPending`

`reassignWorkOrder` runs the same gate between `create` and
`ensurePendingForAssignment`, so a refused reassignment rolls back both the
supersede of the old assignment and the creation of the new one.

Proven empirically by the new suite (`tests/release-integration-merged-e2e.test.ts`):

* **S2** — a MANDATORY gap returns 409 and leaves **0** assignment rows,
  **0** `handyman_assignment_responses` rows, **0** notifications and **0**
  competency-ledger rows.
* **S3** — a qualified worker receives **one** payload carrying both
  `responseStatus: "PENDING"` and `competency.satisfied: true`, and both rows
  are persisted against the same assignment id.

### C2. TERIMA / TIDAK_BISA lifecycle and IN_APP notifications — PASS

Preserved from PR #56 unchanged: idempotent replay, `TERIMA` → `ACKNOWLEDGE`
integration (single `work_order_actions` row, SLA fulfilment, no duplicated
events), `TIDAK_BISA` requires a reason, never cancels the Work Order, sets
`reassignmentRequired`, and notifies Operations `IN_APP`.

Evidence: `handyman-assignment-response-part02a/02b/02c` (8/8, 5/5, 6/6) and
release-integration S4/S5/S6.

### C3. DIRECT freelance workforce needs no vendor company — PASS

Migration `0466` adds `handyman_provider_contexts.provider_type`
(`VENDOR | DIRECT`), makes `vendor_id` nullable under an identity CHECK, adds a
partial unique index for exactly one DIRECT context per Client, and adds
`FREELANCE` to `workforce_profiles.workforce_type`. Existing rows default to
`VENDOR` (verified on the simulated production database).

Evidence: `handyman-direct-workforce-03b2d` (20/20) and release-integration S7
(a `FREELANCE` profile is assigned with `vendorId: null`).

### C4. Permission revocation applies to the NEXT request — PASS

`rbac.middleware.ts` calls `permissionService.resolvePermissionsForUser()` on
**every** request; that function is a straight
`permissionRepository.listActivePermissionCodesForUser()` call with **no cache,
no memoisation and no session snapshot** in the permission module.

Evidence: `permission-revocation` (8/8) and release-integration S8 — a revoked
`work_order.manage` grant yields 403 on the very next call while the remaining
`work_order.read` grant still works and the credential row is untouched.

### C5. Foto Nota, Reimbursement Finance, Helper Attendance — PASS

| Surface | Where | Evidence |
| --- | --- | --- |
| Foto nota / receipt integrity (`receipt_sha256_checksum`, supplier-invoice uniqueness) | `0470`, `handyman_material_purchase_records` | `handyman-field-expense-reimbursement` 3/3 |
| Finance reimbursement approve / reject / disburse | `/handyman/…/material-purchases/{id}/reimbursement/*` | same suite; OpenAPI paths present |
| Helper attendance confirm + personnel changes | `0471`, `handyman-helper-attendance` | `handyman-helper-attendance-confirmation` 3/3 |

### C6. Super User and all existing passwords preserved — PASS

* No seed change touches users, credentials or password hashes; the only seed
  delta is **additive** (`workforce_certification.read/manage/verify`, with
  `verify` withheld from every role by default).
* Migration harness check **G** upgrades the simulated production database and
  proves `user_credentials.password_hash` rows are **byte-identical** and
  `users` / `roles` / `user_role_assignments` counts are unchanged.

### C7. Every route registered exactly once — PASS

Runtime inventory of the composed Express app: **2,032** registered routes,
**2,031** distinct `METHOD path` pairs (2,034 / 2,033 with the WhatsApp webhook
router enabled, which the parity suite enables).

The single duplicate is `GET /tasks/{p}` (`/tasks/:id` and `/tasks/:taskId`),
which **also exists on `main`** (main: 1,985 routes, same single duplicate) —
pre-existing and unrelated to this integration.

Each of the five new routers is mounted exactly once in `src/routes/index.ts`,
and each of the seven Work Order assignment routes is declared exactly once.

### C8. No Mobile / Operations contract regression — PASS

| Guard | Result |
| --- | --- |
| `handyman-contract-freeze-03-openapi` (runtime/service parity + metadata) | 13/13 |
| `openapi-operational-final-parity` | 7/7 |
| `openapi-operational-structural-closure` | 8/8 |
| `openapi-saas-route-parity` | 15/15 |
| `mobile-assignment-contract` | 18/18 |
| `e2e-operational-lifecycle-04a` | 17/17 |

OpenAPI is a strict superset of both release lines with **zero** duplicate
operationIds and zero broken local `$ref`s.

### C9. QR/GPS arrival and evidence upload — no duplicate module — PASS

The arrival/QR/GPS and evidence authorities are the pre-existing ones; nothing
was cloned. New module directories are exactly the six that the three sources
introduced (`assignment-responses`, `handyman-helper-attendance`,
`service-competency-requirements`, `work-order-trade-categories`,
`worker-competency-eligibility`, `workforce-certifications`) — no
`*-v2`, no parallel evidence or arrival module.

Evidence: `handyman-arrival-verification-api` 10/10,
`handyman-arrival-challenges` 10/10, and 04A test 08 (photo evidence bound and
streamed through the shared `/evidence/:id/file` route).

---

## D. Migration verification — PASS (14/14)

See `…_MIGRATION_RECONCILIATION.md` for the full matrix. Summary:

* Fresh migrate on **PostgreSQL 18.4**: 470/470 migrations, tip
  `0472_handyman_assignment_responses`, `0469` absent.
* Immediate re-run: **0** migrations re-applied, history unchanged.
* Upgrade from the simulated Biznet representation (`…0460` + historical
  users/roles/credentials): **11** migrations applied, password hashes
  byte-identical, re-run a no-op.
* `0472`'s in-place ledger repair verified non-destructively.

## E. Focused E2E — PASS (309 assertions across 29 suites)

See the matrix in the release manifest. `npm run typecheck` and `npm run build`
both exit 0.

---

## Fixes made during integration (not feature work)

1. **Merged service composition** (B3): the competency gate and the response
   lifecycle were written by two release lines into the same file. They were
   composed into one transaction rather than serialised one after the other.
2. **`tests/handyman-scope-assignments-api.test.ts`** — **pre-existing red on
   `main`**: the PART C namespace guard still assumed only the two crew
   assignment URL shapes, but `main` already documents
   `/handyman/requests/{id}/inspector-assignments/history`. Reconciled by
   whitelisting the separately governed response sub-resources while still
   rejecting any other handyman assignment path.
3. **`tests/openapi-operational-*`** — **pre-existing red on `main`** after the
   later PARTs landed: census pins refreshed to the merged measurement
   (2,034 / 1,964 / 1,963 / 69). The structural invariants were **not** weakened.

## Known limitations (environmental, not regressions)

| Suite | Behaviour | Cause |
| --- | --- | --- |
| `work-order-assignment` | 20 skipped | Requires a local PostgreSQL `asentra_test`; superseded by the embedded-PG suites that do run |
| `handyman-evidence-commands` | 7 skipped | Same |
| `evidence-file-api` | 5 skipped | Same |

`mobile-assignment-contract` needs `ASENTRA_USE_EMBEDDED_POSTGRES=true`
(documented in that suite); with the flag it is 18/18.

---

## Release recommendation

**PASS — release candidate ready for FINAL REVIEW.** No PR was opened, nothing
was merged, pushed to `main`, or deployed.
