# CR-HM-SEC-01 — PART 01 DECISION REPORT (Handyman-Backend only)

**Status: IMPLEMENTED + VERIFIED, 2026-10-08.** Assigned branch:
`arena/a266c5e9-handyman-backend`; baseline HEAD
`2cca96e4e7a0b7090882be0778f9d341b734fb42` (= remote `main` at start);
tracked tree clean at start. No branch creation/switch. No PR/merge.

Scope of this PART: establish the existing authority for explicit
client-wide vs building-scoped access, implement the smallest reusable
authorization guard, and apply it to **quotation creation first** only.

## 0. Referenced runtime-verification doc

The assigned brief references `docs/handyman/PART00D2B_RUNTIME_[VERIFICATION.md]`.
**That file does not exist in this repository** (searched the whole tree;
no `PART00*`, `RUNTIME*`, or `*VERIFICATION*` doc under `docs/handyman/`).
The nearest existing runtime authorities were used instead and are cited
below: `docs/data-isolation.md` (BE-02G), `docs/effective-context.md`
(BE-01I + BE-02H + BE-25B), `docs/backend-foundation.md`.

## 1. Authority establishment — explicit client-wide vs building-scoped

Evidence chain (existing contracts only, no inference):

| # | Source | What it establishes |
|---|---|---|
| A1 | `docs/data-isolation.md` (BE-02G) | Access = authentication + RBAC permission + **explicit ACTIVE `user_building_assignment` to the exact Building** + ACTIVE Building. "**No same-Client shortcut.** Having access to one Building under a Client does not authorize the other Buildings of that Client." "Cross-Client access is allowed only when explicitly assigned." |
| A2 | Migration `0019_create_user_building_assignments` | `user_building_assignments` is per-`building_id` only; "assignment does not imply global or sibling access". **No user↔client assignment table exists anywhere in the schema.** |
| A3 | `src/modules/roles/role.types.ts`, permission seed `src/database/seeds/foundation-access.seed.ts` | Roles carry RBAC **capabilities only** — no scope dimension. `tenant_company.manage` is a capability, not data scope. |
| A4 | `src/modules/context-access/context-access.service.ts` | `canAccessClient` is documented as "True when the User has explicit access to a **Building under** this Client" — a derived reachability fact. `getAccessibleClientIds` is documented as the query-scope foundation **"for legacy operational tables that are Client-scoped only (no building_id column)"**. Neither is a grant of client-wide privilege. |
| A5 | `src/modules/handyman-requests/handyman-service-request.repository.ts` (C6 read wall) | The only role-based operational exception, `PLATFORM_ADMIN`, "may read historical requests, but **only in its assigned Building**" — even the platform admin is building-scoped. |
| A6 | Migration `0378_create_handyman_service_requests` | The quotation's parent resource is **building-scoped**: `handyman_service_requests.building_id UUID NOT NULL` (server-derived from the CR-HM-01 attribution, immutable). |
| A7 | `docs/effective-context.md` | `scope.clientIds` = "Clients **reachable through** the accessible Buildings" — reachability, not privilege. |
| A8 | CR-HM-06 frozen actor rule (`docs/handyman/CR-HM-06_START_GOVERNANCE.md` §D/Q2) | Actor = "authenticated local session user holding client-scoped RBAC on the request's `clientId` (existing `tenant_company.*` conventions)". |

**Decision (no ambiguity, no frozen-contract conflict — implemented):**

- **Building-scoped access is the sole authoritative user data-scope.** A
  building-scoped resource (clientId + buildingId) is authorized by the
  actor's explicit ACTIVE assignment to the resource's **exact** Building
  resolving under the resource's Client.
- **No client-wide privilege is inferred from any single building
  assignment.** The pre-existing `canAccessClient` wall on quotation
  creation was exactly such an inference: an actor assigned only to
  Building A1 could create a quotation for a request at sibling Building
  A2 of the same Client — the same-client shortcut BE-02G forbids (A1).
- **No legitimate client-wide access exists to preserve.** No existing
  role/scope contract grants any local User client-wide data access
  (A2/A3/A5): roles have no scope, there is no user↔client assignment,
  and even PLATFORM_ADMIN stays inside its assigned Buildings. The only
  policy-supported shape of "client-wide reach" is an **explicit ACTIVE
  assignment to every building of the client** — which the guard admits
  per-building and which test 4 proves is preserved.
- The guard is **strictly stronger** than the frozen CR-HM-06 actor rule
  (A8), not in conflict with it: an actor with explicit access to the
  request's Building necessarily holds client-scoped RBAC reach on the
  request's Client (Building → Property → Client), so the frozen minimum
  authority is still satisfied. Tightening does not weaken any frozen
  requirement; it enforces the BE-02G isolation ceiling (A1) that the
  client-level implementation violated.

## 2. Implementation (smallest reusable guard)

| File | Change |
|---|---|
| `src/modules/context-access/context-access.service.ts` | ADD `BuildingScopedResourceRef` type + `canAccessBuildingScopedResource(userId, { clientId, buildingId })` predicate + `assertBuildingScopedResourceAccess(...)` (throws 403 `BUILDING_ACCESS_DENIED`, no existence leak). Single pass over the BE-02F resolver; fail-closed on client mismatch. Exported via `contextAccessService` and the module index. **No existing function changed.** |
| `src/modules/context-access/index.ts` | Re-export the two new guard functions + the type. |
| `src/modules/handyman-quotations/handyman-quotation.service.ts` | `createHandymanQuotation` step 2: the client-level `canAccessClient` wall is **replaced** by `assertBuildingScopedResourceAccess(actorUserId, { clientId: request.clientId, buildingId: request.buildingId })`. **Quotation creation only** — no other lifecycle step touched in this PART. |

The guard is deliberately generic (clientId + buildingId resource ref) so
later PARTs can apply it to the remaining affected endpoints listed in §5
without inventing a second mechanism.

## 3. Focused tests — `tests/handyman-quotation-scope-guard.test.ts` (4 cases)

| # | Case | Result |
|---|---|---|
| 1 | **Authorized building** — actor with explicit ACTIVE assignment to the request's building (service + HTTP `POST /handyman/requests/:id/quotation` → 201, version 1 DRAFT, rows + event created) | PASS |
| 2 | **Same-client sibling building denied** — actor assigned only to a sibling building of the same client/property: service rejects with 403 `BUILDING_ACCESS_DENIED`; HTTP 403 with `error.code === 'BUILDING_ACCESS_DENIED'`; **zero mutation** (0 quotations, 0 versions, 0 events). The test also pins that the old wall (`canAccessClient`) passed for this actor while the guard denies. | PASS |
| 3 | **No-client access denied** — (a) actor assigned under a *different* client, and (b) actor holding `tenant_company.manage` with **zero** assignments (permission ≠ data scope): both 403 at service and HTTP, zero mutation. | PASS |
| 4 | **Explicitly authorized client-wide reach preserved** — the only policy-supported shape: explicit ACTIVE assignments to **every** building of the client → allowed (service + HTTP 201). Also pins that a single foreign-building assignment does not satisfy the guard. | PASS |

The "explicitly authorized client-wide actor allowed" case is supported
**only** in the per-building form above: no existing role/scope contract
grants client-wide access independent of per-building assignments (§1),
so no client-wide bypass test exists and none was invented.

**Vulnerability-detection check:** with the guard reverted to the old
client-level `canAccessClient` check, test 2 **fails** (the sibling actor
is wrongly allowed to create a quotation); with the guard in place all 4
tests pass. The test suite therefore detects the vulnerability, it does
not merely pass vacuously.

## 4. Verification evidence (2026-10-08, this branch)

- Baseline gates: branch `arena/a266c5e9-handyman-backend`, HEAD
  `2cca96e4e7a0b7090882be0778f9d341b734fb42`, tracked tree clean. No
  branch created/switched.
- `npx tsc --noEmit` (project `typecheck`, changed src files): **clean**.
  Standalone strict typecheck of the new test file: **clean**.
- `git diff --check`: **clean** (no whitespace errors).
- Affected tests run (embedded PostgreSQL 18.4 test DB, sequential):

| Suite | Result |
|---|---|
| `handyman-quotation-scope-guard` (new) | 4/4 pass |
| `handyman-quotation` | 10/10 pass |
| `handyman-quotations-api` | 10/10 pass |
| `handyman-quotation-decision` | 10/10 pass |
| `handyman-quotation-lifecycle` | 10/10 pass |
| `handyman-quotation-line` | 10/10 pass |
| `handyman-arrival-challenges` | 10/10 pass |
| `handyman-arrival-locations` | 10/10 pass |
| `handyman-customer-care-request-reads` | 8/8 pass |
| `handyman-execution-scope` | 10/10 pass |
| `handyman-execution-scope-assignments` | 10/10 pass |
| `handyman-execution-scope-assignment-service` | 10/10 pass |
| `handyman-geospatial-policies` | 10/10 pass |
| `handyman-provider-availability` | 4/4 pass |
| `handyman-charge-composition` | 6/6 pass |
| `handyman-ledger-corrections` | 6/6 pass |
| `handyman-payment-allocation` | 6/6 pass |
| `data-isolation` (context-access module) | 15/15 pass |
| `building-assignments` (context-access module) | 17/17 pass |

- **Pre-existing failures, identical on the pristine tree (verified by
  stashing this PART's changes and re-running): NOT caused by this PART.**
  - `handyman-customer-care-transport-certification`: 0/5 — environmental
    git-revision check (`fatal: bad revision '2fcfad9..HEAD'`).
  - `handyman-scope-assignments-api`: 9/10 — OpenAPI/runtime parity path
    list drift (downstream route paths).
  - `handyman-customer-payments`: 5/6 — module file-listing "firewall
    sweep" assertion (extra `available-actions.ts` file).
- Runtime DB was available (embedded PostgreSQL on the test port); no
  ENV_BLOCKED condition.

## 5. Remaining affected endpoints (NOT broadened in this PART)

The guard is applied to **quotation creation only**
(`POST /handyman/requests/:handymanRequestId/quotation` /
`createHandymanQuotation`). The rest of the CR-HM-06 quotation surface
still authorizes on the client-level `canAccessClient` wall over
building-scoped resources and is the remaining exposure to be guarded in
later PARTs (same guard, same authority §1):

| Operation | Route | Site |
|---|---|---|
| `createHandymanQuotationRevision` | `POST /handyman/quotations/:quotationId/versions` | `handyman-quotation.service.ts:189` |
| `getHandymanQuotation` | `GET /handyman/requests/:handymanRequestId/quotation` | `handyman-quotation.service.ts:242` |
| `addHandymanQuotationLine` | `POST /handyman/quotation-versions/:quotationVersionId/lines` | `handyman-quotation-line.service.ts:161` |
| `listHandymanQuotationVersionLines` | `GET /handyman/quotation-versions/:quotationVersionId/lines` | `handyman-quotation-line.service.ts:289` |
| `getHandymanQuotationVersionTotals` | `GET /handyman/quotation-versions/:quotationVersionId/totals` | `handyman-quotation-line.service.ts:321` |
| `issueHandymanQuotationVersion` | `POST /handyman/quotation-versions/:quotationVersionId/issue` | `handyman-quotation-lifecycle.service.ts:76` (via `requireAccessibleQuotation`) |
| `expireHandymanQuotationVersion` | `POST /handyman/quotation-versions/:quotationVersionId/expire` | `handyman-quotation-lifecycle.service.ts:301` |
| `supersedeHandymanQuotationVersion` | `POST /handyman/quotation-versions/:quotationVersionId/supersede` | `handyman-quotation-lifecycle.service.ts` (via `requireAccessibleQuotation`) |
| `decideHandymanQuotation` | `POST /handyman/quotation-versions/:quotationVersionId/decision` | `handyman-quotation-decision.service.ts:166` |
| `getHandymanQuotationDecision` | `GET /handyman/quotation-versions/:quotationVersionId/decision` | `handyman-quotation-decision.service.ts:336` |
| `getHandymanExecutionScopeByQuotationVersion` | `GET /handyman/quotation-versions/:quotationVersionId/execution-scope` | `handyman-execution-scope.service.ts:170` |
| `getCurrentHandymanIssuedQuotationVersion` | `GET /handyman/requests/:handymanRequestId/quotation/presented` | `handyman-quotation-lifecycle.service.ts:301` |

Wider handyman surface still on the client-level wall (out of this PART's
scope, same authority applies): `handyman-requests` intake/list/detail and
the triage/inspection/diagnosis/referral stage services
(`handyman-service-request.service.ts:244,312,338`,
`handyman-request-{triage,inspection,diagnosis,referral}.service.ts`),
`handyman-arrival-challenges`, `handyman-arrival-locations`,
`handyman-arrival-results`, `handyman-bast`, `handyman-catalog`,
`handyman-chargeable-additional-works`, `handyman-customer-ledger-*`,
`handyman-sla-status-api`, and the care-actor property-scope service.
Legacy **Client-scoped-only** tables (no `building_id` column) legitimately
keep `getAccessibleClientIds`/`canAccessClient` scoping per A4 — that use
is not affected by this PART.

## 6. Exclusions observed

No schema/migration change. No OpenAPI change. No change to any lifecycle
step other than quotation creation. No client-wide bypass invented. No
role/permission/seed change. No PR/merge. Branch unchanged.
STOP.
