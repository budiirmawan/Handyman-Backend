# CR-BE-UTL-02 START GOVERNANCE

## Superseded Utility Calculation Approval Guard

**Status:** governance/start only. No PART implementation is included in this change.
**Scope:** close the approval-integrity gap where a `UTILITY_CALCULATION` approval binding can remain `PENDING` and keep advertising/accepting `APPROVE`/`REJECT` after its underlying Utility Calculation is no longer FINAL and approval-eligible (e.g. `SUPERSEDED`).

---

## 1. Repository review and current-state authority

The Tenant utility approval is implemented on the existing BE-14H approval primitive
(BE-18L, CR-BE-UTL-01 PART 11). Inspection results:

- **Binding table** — `tenant_approval_bindings`
  (`src/database/migrations/0194_add_utility_tenant_approval_binding.ts`,
  `0279_add_tenant_utility_billing_handoff.ts`). A `UTILITY_CALCULATION` binding stores
  `utility_calculation_id` plus an immutable charge snapshot
  (`utility_space_id`, `utility_meter_id`, `utility_meter_purpose`, tariff, period,
  amount, currency). The DB CHECK `tenant_approval_utility_snapshot_check` guarantees a
  complete TENANT snapshot at insert time.
- **Binding creation** — `createTenantApproval`
  (`src/modules/tenant-approvals/tenant-approval.service.ts:203`) resolves the target via
  `resolveRequest` → `resolveUtilityCalculationRequest` (`:110`), which maps
  `calculation.status === 'FINALIZED' ? 'OPEN' : calculation.status` (`:176`), and
  refuses any `target.status !== 'OPEN'` (`:207`). A SUPERSEDED (or DRAFT) calculation
  therefore **cannot be bound** — creation is already guarded.
- **Context endpoint** — `getUtilityCalculationApprovalContext` (`:323`) re-resolves the
  calculation at request time and exposes `approvable: target.status === 'OPEN'` (`:339`).
  It already reports `approvable: false` for a SUPERSEDED calculation.
- **Available-actions** — `resolveTenantApprovalAvailableActions` (`:353`) delegates to
  `resolveAllowedActions` (`:363`).
- **Decision path** — `decide` (`:295`) is the single guard for both `approve`/`reject`;
  it gates on `resolveAllowedActions(record, actorUserId).has(action)` (`:309`).
- **Calculation lifecycle** — `utility_calculations.status` is `DRAFT | FINALIZED |
  SUPERSEDED` (`src/database/migrations/0191_create_utility_calculations.ts`). DRAFT →
  FINALIZED freezes; DRAFT → SUPERSEDED retires a draft in favour of a successor row.
  The repository guards (`markSuperseded ... WHERE status = 'DRAFT'`, `markFinalized ...
  WHERE status = 'DRAFT'`) and the service refusals (`recalculateUtilityValue` rejects
  FINALIZED/SUPERSEDED) make FINALIZED → SUPERSEDED unreachable through the public API
  today — the binding decision path, however, never verifies current status.
- **Same-engine reference pattern** — the procurement engine re-resolves the request for
  **every** binding before offering actions
  (`src/modules/procurement-approvals/procurement-approval.service.ts:286-296`); the
  tenant engine already does this for `SERVICE_REQUEST`/`COMPLAINT`/`UTILITY_REQUEST`
  (`tenant-approval.service.ts:372-374`) but **skips it for `UTILITY_CALCULATION`**
  (`:375-376`).

## 2. Exact gap

`resolveAllowedActions` (`src/modules/tenant-approvals/tenant-approval.service.ts:363`):

```ts
async function resolveAllowedActions(record, actorUserId) {
  const allowed = new Set<TenantApprovalAction>();
  if (record.status !== 'PENDING' || record.approverUserId !== actorUserId) return allowed;
  if (!(await canApprove(actorUserId, record.buildingId))) return allowed;
  if (record.requestType !== 'UTILITY_CALCULATION') {
    const target = await resolveRequest(record.requestType, requestId(record));
    if (target.status !== 'OPEN') return allowed;          // re-checks the target
  } else if (!record.utilitySpaceId || record.utilityMeterPurpose !== 'TENANT') {
    return allowed;                                         // snapshot fields only
  }
  allowed.add('APPROVE');
  allowed.add('REJECT');
  return allowed;
}
```

For `UTILITY_CALCULATION` bindings the **current** status of the underlying calculation
is never re-read. The `else if` branch only re-checks snapshot fields that were validated
once at creation time. Consequences:

1. If a binding is `PENDING` and its calculation is later no longer FINAL (e.g. becomes
   `SUPERSEDED`), `resolveTenantApprovalAvailableActions` still advertises
   `['APPROVE', 'REJECT']` — while `getUtilityCalculationApprovalContext` for the same
   calculation reports `approvable: false`. The two backend-authoritative surfaces
   **disagree**; this inconsistency is the approval-integrity gap.
2. `decide()` gates only on `resolveAllowedActions`, so the decision path still **accepts**
   `APPROVE`/`REJECT` for that binding.

A PENDING binding is a *claim that the charge may still be decided*. That claim must be
re-validated against the calculation at decision time, exactly as it is for every other
request type and in the procurement engine.

## 3. Smallest safe implementation

One-function change in `src/modules/tenant-approvals/tenant-approval.service.ts` —
`resolveAllowedActions`:

- Keep the `UTILITY_CALCULATION` snapshot sanity guard (incomplete/`non-TENANT` snapshot
  → no actions), hoisted so it applies to the utility branch only.
- Apply the **same** `resolveRequest(record.requestType, requestId(record))` →
  `target.status !== 'OPEN'` gate to all four request types, so `UTILITY_CALCULATION`
  re-resolves the calculation and inherits the existing `FINALIZED → OPEN` mapping from
  `resolveUtilityCalculationRequest`.

Resulting rule (single source of truth, same choke point for advertisement **and**
decision):

> A binding may advertise/accept `APPROVE`/`REJECT` only while it is `PENDING`, the
> actor is the assigned approver with valid RBAC + Building access, the stored snapshot
> is a complete TENANT snapshot, **and the underlying calculation currently resolves to
> OPEN (FINALIZED and context-valid)**. A SUPERSEDED (or DRAFT) calculation is never
> approvable or rejectable.

Why this is safe:

- **No engine redesign** — the decision primitive, repository, routes, validation,
  errors, and RBAC are untouched.
- **No schema/migration** — enforced at decision time, not by data shape.
- **No behavior change for the other three request types** — they already take the
  `resolveRequest` + OPEN path; the restructure is behavior-neutral for them.
- **No behavior change for healthy utility bindings** — a PENDING binding on a still
  FINALIZED calculation keeps `APPROVE`/`REJECT` (the existing available-actions test
  still passes).
- **History/auditability preserved** — binding rows are never mutated or deleted; a
  denied decision simply leaves the binding `PENDING` (or returns the existing
  `TENANT_APPROVAL_ACTION_NOT_ALLOWED` 403 on the decision routes).
- **Consistency restored** — available-actions, the decision path, and
  `getUtilityCalculationApprovalContext` now all re-resolve the calculation and agree.
- **Read models inherit the fix** — `management-pending-approval` delegates to
  `resolveTenantApprovalAvailableActions`, so its advertised actions close too.

Behavior on a SUPERSEDED underlying calculation (after PART 01):

- `GET /tenant-approvals/:id/available-actions` → `availableActions: []`
  (state stays `PENDING`).
- `POST /tenant-approvals/:id/approve` / `.../reject` → `403
  TENANT_APPROVAL_ACTION_NOT_ALLOWED`; the binding row remains `PENDING`, undecided.
- Vanished/broken context (calculation deleted or its Meter/Tenant chain no longer
  consistent) → the existing `resolveRequest` errors, identical to the behavior already
  in place for the other three request types.

## 4. Small PART breakdown (implementation deferred)

- **PART 01 — Decision-path guard:** modify `resolveAllowedActions` in
  `src/modules/tenant-approvals/tenant-approval.service.ts` so `UTILITY_CALCULATION`
  bindings re-resolve the underlying calculation and require `target.status === 'OPEN'`
  (currently FINALIZED + context-valid), keeping the snapshot sanity guard. No other
  production file changes.
- **PART 02 — Regression tests:** in `tests/utility-tenant-approvals.test.ts`, (a) update
  the comment in the existing *"keeps approval actions available while the binding itself
  is PENDING"* test, which currently documents the gap behavior, and (b) add a targeted
  test: bind a FINALIZED calculation, move the calculation to `SUPERSEDED` via a direct
  DB status update (the public API intentionally refuses FINALIZED → SUPERSEDED, so the
  state is forced to reproduce the invariant), then assert available-actions are empty,
  approve/reject are refused with `TENANT_APPROVAL_ACTION_NOT_ALLOWED` (403), and the
  binding remains `PENDING` and undecided.
- **PART 03 — Verification (not full regression):** `npm run typecheck`, then run only
  `tests/utility-tenant-approvals.test.ts` and `tests/tenant-approvals.test.ts` to prove
  the fix and the unchanged `SERVICE_REQUEST`/`COMPLAINT`/`UTILITY_REQUEST` paths.
  OpenAPI is unchanged (available-actions contract is unchanged).

## 5. Affected files and targeted tests

Production (the only file expected to change in PART 01):

- `src/modules/tenant-approvals/tenant-approval.service.ts` — `resolveAllowedActions`
  (lines ~363-377); the decision path `decide` (`:295`) is covered by the same fix
  through `resolveAllowedActions` (`:309`).

Tests:

- `tests/utility-tenant-approvals.test.ts` — update misleading comment at `:749-758`;
  add the SUPERSEDED regression test (PART 02).
- `tests/tenant-approvals.test.ts` — existing suite re-run only; no edits expected.
- `tests/management-pending-approval.test.ts` — optional; inherits the fix via
  `resolveTenantApprovalAvailableActions`, no edits expected.

Artifact:

- `docs/CR-BE-UTL-02_START_GOVERNANCE.md` — this governance document.

Not affected (explicitly preserved): approval engine/repository/routes/validation/errors,
RBAC (`tenant_company.manage`/`read`), Client/Building isolation
(`contextAccessService.assertBuildingAccess`, SQL-scoped lists), approval history and
audit rows, CR-BE-UTL-01 contracts (binding shape, snapshot CHECK constraint, context
endpoint, `approvable` semantics), Utility Calculation lifecycle behavior, frontend, and
OpenAPI.

## 6. Validation and stop state

Repository review completed against the binding migration, tenant-approval
service/repository/routes/types/errors, utility-calculation service/repository/routes,
management-pending-approval delegation, procurement-approval reference pattern, the
CR-BE-UTL-01 handoff doc, and the relevant test files. Per the CR instruction, **no `npm
test` and no full regression were run**, **no implementation was changed**, **no branch
was created** (working on the fixed session branch
`arena/01a027c5-asentra-backend`), and **no PR was opened**. Implementation is
intentionally stopped here.
