# CR-HM-04 — EXECUTION SCOPE ASSIGNMENT ACTIVATION CERTIFICATION

**Status: CERTIFIED, 2026-09-28, base `aca76b7`.** Certification
ONLY. This document records evidence; it changes NO runtime, NO
migration, NO tests, NO OpenAPI, NO governance/roadmap document,
NO CR-HM-07 runtime or status beyond the explicit dependency
resolution recorded in §11–§12 below. The known environment
regression (sandbox tree resets) is operational only, not product
debt; the verified remote assigned-branch tip is the sole authority.

Sources read (read-only):

1. `CR-HM-04_EXECUTION_SCOPE_ASSIGNMENT_ACTIVATION.md` (FROZEN
   activation governance §1–§9, tokens);
2. PART A migration/schema + suite result
   (`src/database/migrations/0396_create_handyman_execution_scope_assignments.ts`,
   `tests/handyman-execution-scope-assignments.test.ts`);
3. PART B services/resolver + suite result
   (`src/modules/handyman-scope-assignments/`,
   `tests/handyman-execution-scope-assignment-service.test.ts`);
4. PART C HTTP/OpenAPI + suite result
   (`src/modules/handyman-scope-assignments-api/`,
   `docs/api/openapi.yaml`,
   `tests/handyman-scope-assignments-api.test.ts`);
5. CR-HM-07 START governance blocker section
   (`CR-HM-07_START_GOVERNANCE.md` §D/§N).

Certified commits: PART A `4d96141`, PART B `86f4e47`, PART C
`aca76b7`.

## 1. TARGET = HANDYMAN_EXECUTION_SCOPE / executionScopeId

CERTIFIED. The assignment contract targets `targetType=
HANDYMAN_EXECUTION_SCOPE`, `targetId=executionScopeId` exactly
(PART 06 §1/§3; activation governance §1). No other target type
exists anywhere in the activation; the scope row is referenced,
never mutated (CR-HM-06 ownership intact).

## 2. PERSISTENCE = 0396 assignment table

CERTIFIED. Migration `0396_create_handyman_execution_scope_assignments`
creates `handyman_execution_scope_assignments` exactly per governance
§3 (id, client_id, execution_scope_id, handyman_provider_context_id,
handyman_crew_id, status, assigned_by_user_id, assigned_at,
supersedes_assignment_id, timestamps). Invariants hold:

- **Exactly one ACTIVE assignment per scope** — partial unique index
  `(execution_scope_id) WHERE status='ACTIVE'` (0393-class pattern);
- **append-only supersession history** — SUPERSEDED rows are never
  updated/deleted; every create/supersede journals
  `HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED` /
  `..._SUPERSEDED` operational events (entityType
  `HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT`; audit-only, never lifecycle
  authority);
- **no Lead snapshot** — the table and record carry no lead column;
  Lead identity is resolved dynamically (§5).

## 3. ASSIGNMENT validation

CERTIFIED. `assignHandymanExecutionScopeCrew(input, actorUserId)`
server-verifies, in a single transaction with the scope row locked
`FOR UPDATE`: scope exists → `status='AUTHORIZED'` → same-Client
chain end to end (scope ⟂ provider context ⟂ crew —
`CONTEXT_MISMATCH` otherwise) → provider context ACTIVE and crew
ACTIVE (`CONTEXT_INACTIVE` otherwise) → crew belongs to provider
context → exactly one valid login-capable current Lead exists
(ACTIVE membership + ACTIVE worker context + NON-NULL `userId`;
`LEAD_INVALID` fail-closed otherwise). Caller never supplies
clientId/status/Lead/timestamps/provenance (anti-smuggling, F9).

## 4. REASSIGNMENT atomicity

CERTIFIED. `reassignHandymanExecutionScopeCrew` performs, in ONE
`withTransaction`: new-target full §3 eligibility validation BEFORE
any mutation → current ACTIVE → `SUPERSEDED` → insert new ACTIVE
with `supersedes_assignment_id` = old id → journal SUPERSEDED +
CREATED events. On any failure the transaction rolls back: the old
ACTIVE assignment remains authoritative (PART B t5/t6/t8; PART C t4
proves SUPERSEDED old + exactly-one-ACTIVE new at the DB level).

## 5. LEAD AUTHORITY = dynamic chain, no parallel authority

CERTIFIED. `resolveHandymanAssignmentLead(executionScopeId,
actorUserId)` resolves server-side, every call, through the frozen
chain:

```
executionScopeId
  → ACTIVE assignment (partial-unique, exactly one)
  → handyman_crew_id
  → current CR-HM-04 Lead (existing `handyman_crew_leads` current row)
  → ACTIVE worker context
  → leadUserId (NON-NULL, Lead invariant)
```

None ("no ACTIVE assignment" → `HANDYMAN_EXECUTION_SCOPE_
ASSIGNMENT_NOT_FOUND`-shaped / resolver null; "no valid current
Lead" → `LEAD_INVALID`) is a distinguished bounded failure. A
legitimate CR-HM-04 Lead change (`designateHandymanCrewLead`) is
reflected at the very next resolution — proven PART B t9 and PART
C t3. No parallel Lead authority exists; the assignment row is
never read as Lead evidence.

## 6. CR-HM-07 CONSUMER contract

CERTIFIED. The internal authoritative resolver
`resolveHandymanAssignmentLead({executionScopeId}, actorUserId)`
exists and is public-cross-module read only. CR-HM-07 may consume
it read-only for its §D actor gate. Caller `workerId`/`crewId`/
`leadUserId` must never replace resolver authority — the HTTP body
whitelist (PART C validation) structurally ignores them, and the
resolver invocation is server-composed only.

## 7. HTTP surface = exactly 3 operations / 2 URL shapes

CERTIFIED. PART C mounts exactly:

- `POST /handyman/execution-scopes/:executionScopeId/assignment`
- `GET  /handyman/execution-scopes/:executionScopeId/assignment`
- `POST /handyman/execution-scopes/:executionScopeId/assignment/reassign`

Three HTTP operations total (no list, no collection endpoint, no
`lead-actor` subresource — CR-HM-07 consumes the internal resolver
directly, so no public Lead-resolver endpoint was required or
created). Routes are thin shells over PART B services; validation/
business rules live solely in the runtime (not duplicated in HTTP).
GET returns the bounded view: `assignmentId, executionScopeId,
providerContextId, crewId, status, leadWorkerContextId, leadUserId`
(+ `assignedByUserId, assignedAt, supersedesAssignmentId`
derivation facts).

## 8. RBAC

CERTIFIED. GET = `tenant_company.read`; both POSTs =
`tenant_company.manage` (existing vocabulary, no new permission);
actor always the authenticated session user (`req.auth.userId`)
with the existing context-access per-child guard. Strict split
proven: read-only ↔ manage-only accounts each receive 403 across
the other's routes (PART C t5/t6); session identity beats smuggled
actor fields (t7).

## 9. FIREWALL verification = ZERO

CERTIFIED. The activation contains ZERO of: scheduling (CR-HM-05);
arrival/challenge/QR/GPS/geofence (CR-HM-07); work session/CHECK-IN
(CR-HM-08); attendance; payment/BAST (CR-HM-13/CR-HM-11); FM
`work_orders` or any FM lifecycle adoption. Proven at runtime
(PART B t10 side-effect probes against
`handyman_scheduling_readiness`, `handyman_unit_access_readiness`,
`work_orders`, `vendor_quotations`, `bast_documents`) and at the
contract level (PART C t8 smuggling non-echo + t10 forbidden-path/
field scan of the PART C surface and schemas).

## 10. VALIDATION EVIDENCE

| Gate | Result |
|---|---|
| PART A focused suite | 10/10 |
| PART B focused suite | 10/10 |
| PART C focused suite | 10/10 |
| Combined A+B+C regression | 30/30 |
| OpenAPI YAML parse | PASS (2 assignment URL shapes, 3 ops, 3 schemas, 1 param) |
| `git diff --check` (every PART) | PASS |

Suites: `tests/handyman-execution-scope-assignments.test.ts`,
`tests/handyman-execution-scope-assignment-service.test.ts`,
`tests/handyman-scope-assignments-api.test.ts`
(`NODE_ENV=test LOG_LEVEL=error DB_PASSWORD=postgres npx tsx --test
--test-concurrency=1`, embedded PostgreSQL 18).

## 11. CR-HM-07 BLOCKER RESOLUTION

**`CR_HM_07_ASSIGNMENT_BLOCKER=RESOLVED`.**

Reason: the authoritative ACTIVE assignment binding and the dynamic
Lead resolver (governance §4/§5; certified §2–§6 above) now exist —
exactly and only the activation CR-HM-07 §N2 named as its sole
structural blocker. CR-HM-07 may proceed using:

```
executionScopeId → ACTIVE assignment → authoritative Lead userId
```

Per CR-HM-07 §N3, scheduling remains NOT required for CR-HM-07
start (CR-HM-05 schedule binding, if ever activated, MAY only feed
a later risk/confidence corroboration — optional, never a
precondition). This resolution records the dependency state only;
it edits no CR-HM-07 governance section, proposes no CR-HM-07 PART
sequence, and implies no roadmap change.

## 12. STATUS

- **`CR_HM_04_SCOPE_ASSIGNMENT_ACTIVATION=COMPLETE`** — all four
  frozen PARTs (A persistence, B runtime, C HTTP/OpenAPI, D this
  certification) landed and individually gated.
- **`CR_HM_07_IMPLEMENTATION=UNBLOCKED`** — the sole §N2 dependency
  is resolved (§11). CR-HM-07 itself is NOT marked COMPLETE or
  STARTED; any CR-HM-07 work requires its own explicit subsequent
  mandate (its PART 01 is not underway).

---

*Certification only. The activation freeze
(`CR-HM-04_EXECUTION_SCOPE_ASSIGNMENT_ACTIVATION.md`), CR-HM-07
START governance, every certified CR document, and the roadmap are
unchanged. Known sandbox environment regressions recovered each
turn solely from the verified remote assigned-branch tip are
operational, not product debt.*
