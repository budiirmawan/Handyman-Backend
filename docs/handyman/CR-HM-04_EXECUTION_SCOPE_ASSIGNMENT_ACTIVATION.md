# CR-HM-04 — EXECUTION SCOPE ASSIGNMENT ACTIVATION (FROZEN GOVERNANCE)

**Status: FROZEN GOVERNANCE, base `6fd9e09`, 2026-09-28.** Docs-only:
NO runtime, NO migration, NO tests, NO OpenAPI; roadmap and completed
CR documents untouched. Sources read (exclusive):

1. `CR-HM-04_START_GOVERNANCE.md` — decisions F1–F10 (F7 assignment
   boundary, F8 lifecycle, F9 actor/scope, F10 audit/history;
   PART 04 STOP RULE);
2. `CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md` — FROZEN §0–§10;
3. `CR-HM-06_PART06_DOWNSTREAM_BINDING_CONTRACT.md` — FROZEN §1–§12
   (`CR_HM_04_ASSIGNMENT_TARGET=ACTIVATABLE`);
4. CR-HM-06 Execution Scope public model
   (`handyman-execution-scope.types.ts`);
5. `CR-HM-07_START_GOVERNANCE.md` §D/§N (dependency requiring this
   activation);
6. Existing CR-HM-04 runtime naming (`handyman-provider-api` routes
   and `handyman-work-crew` lead repository conventions) for
   identifier/naming reuse only.

## Frozen tokens

| Token | Value |
|---|---|
| ASSIGNMENT_TARGET_TYPE | HANDYMAN_EXECUTION_SCOPE |
| ASSIGNMENT_TARGET_ID | executionScopeId |
| SCOPE_STATE_REQUIRED | AUTHORIZED |
| ACTIVE_ASSIGNMENT_PER_SCOPE | ONE |
| REASSIGNMENT | ATOMIC_SUPERSEDE |
| LEAD_AUTHORITY | CR_HM_04_EXISTING |
| ACTOR | SESSION_USER_CLIENT_RBAC |
| FM_WORK_ORDER | FORBIDDEN |
| CR_HM_04_SCOPE_ASSIGNMENT_ACTIVATION | READY |

## 1. TARGET / ELIGIBILITY

An assignment binds an existing Handyman crew to exactly one
**CR-HM-06 Execution Scope**: `targetType=HANDYMAN_EXECUTION_SCOPE`,
`targetId=executionScopeId` (PART 06 §1/§3). Eligibility at creation
(all server-verified, PART 06 §2; PART 04 §4):

1. scope exists (exact `executionScopeId` row);
2. `scope.status='AUTHORIZED'` (the only CR-HM-06 state);
3. scope's `client_id` == crew's client == provider context's client
   (same-Client chain, end to end);
4. approved quotation/version/decision lineage intact
   (trust the stored FK chain; documented invariant, not re-derivation);
5. crew ACTIVE; provider context ACTIVE; exactly one valid current
   Lead exists at creation time (PART 04 §4);
6. acting user passes RBAC for that Client/provider (§6).

NO FM `work_orders` target, ever (PART 04 §10; PART 06 §10).

## 2. AUTHORITY BOUNDARIES

- **CR-HM-04 owns**: provider context, workers, crews, memberships,
  Lead history, **assignment + assignment history** (F7/F10).
- **CR-HM-06 owns**: Execution Scope creation/immutability;
  activation never mutates a scope (reference-only FK).
- **CR-HM-07 consumes**: the assignment via §5 bounded resolver only;
  never joins authority tables directly in its own semantics.
- **CR-HM-05/08 untouched**: assignment never creates a schedule
  binding (CR-HM-05 PART 05 §7) or a work session (CR-HM-08).

## 3. ASSIGNMENT MODEL (minimum, persistent)

Table `handyman_execution_scope_assignments`, keyed on existing
identifiers exactly as named in the runtime:

| Column | Source / derivation |
|---|---|
| `id` UUID PK | server-generated |
| `client_id` UUID NOT NULL | verbatim from Execution Scope (== crew == provider context) |
| `execution_scope_id` UUID NOT NULL REFERENCES `handyman_execution_scopes(id)` | caller-selected target id (URL/input); validated per §1 |
| `handyman_provider_context_id` UUID NOT NULL REFERENCES `handyman_provider_contexts(id)` | caller-selected provider (URL/input); validated ACTIVE + same-Client |
| `handyman_crew_id` UUID NOT NULL REFERENCES `handyman_work_crews(id)` | caller-selected crew (URL/input); validated ACTIVE + same-Client |
| `status` | `ACTIVE | SUPERSEDED` only (bounded; no invented states) |
| `assigned_by_user_id` UUID NOT NULL | authenticated session actor |
| `assigned_at` TIMESTAMPTZ NOT NULL | server clock |
| `supersedes_assignment_id` UUID NULL | previous ACTIVE assignment of the same scope (reassignment provenance; NULL for first assignment) |
| `created_at` / `updated_at` | server timestamps |

Caller NEVER supplies `clientId`/actor/status/lineage — exactly the
existing CR-HM-04 (and CR-HM-06) anti-smuggling rule (F9).

## 4. CARDINALITY / HISTORY

- Exactly **one ACTIVE assignment per execution scope**, enforced by a
  partial unique index `…(execution_scope_id) WHERE status='ACTIVE'`
  (proven 0393-class pattern).
- **History append-only**: SUPERSEDED rows are never updated/deleted;
  every create/supersede journals an operational event (F10;
  audit-only, journal never lifecycle authority).
- **Reassignment** = one atomic `withTransaction`: lock scope row →
  verify §1 eligibility → move current ACTIVE row to `SUPERSEDED` →
  insert new ACTIVE with `supersedes_assignment_id` = old id. On any
  failure, all or nothing.

## 5. LEAD RESOLUTION (CR-HM-07 consumer contract)

Do NOT create parallel Lead authority. The authoritative field actor
resolves through the **existing** CR-HM-04 chain:

```
executionScopeId
  → ACTIVE assignment (§4)
  → handyman_crew_id
  → current Lead (existing `handyman_crew_leads` current row,
     append-only `lead_seq` history; `findCurrentLead` convention)
  → worker context (ACTIVE)
  → workforce profile userId (NON-NULL — Lead invariant PART 04 §4)
```

Helpers (NULL `userId` worker contexts) can never be resolved as the
actor — consistent with F5. Bounded resolver contract (public,
cross-module read only):

```
resolveHandymanAssignmentLead(executionScopeId, actorClientScope)
  → { assignmentId, crewId, leadWorkerContextId, leadUserId } | none
```

"none" (no ACTIVE assignment / no valid current Lead) must be a
distinguished, non-enumerating-shaped failure to the consumer
(CR-HM-07 maps it to a bounded not-verifiable error). **No
list/dashboard/search surface is required or created.**

Caller `workerId`/`crewId`/`providerId` is NEVER authoritative for the
resolution — the chain above is server-only.

## 6. RBAC

Reuse existing vocabulary exactly: reads `tenant_company.read`,
mutations `tenant_company.manage` (CR-HM-04 provider API convention,
F9 deferred-then-settled). Plus the existing context seam
(`canAccessClient` on the Client; provider-context validation per
PART 04 §4). **No new permission vocabulary is introduced**; none is
demonstrably necessary.

## 7. FIREWALLS (frozen for activation)

NO: scheduling (CR-HM-05); arrival/challenge/QR/geofence semantics
(CR-HM-07); work session / CHECK-IN (CR-HM-08); attendance/payroll;
payment/BAST (CR-HM-13/CR-HM-11); FM `work_orders` or any FM
lifecycle adoption; quota/inventory/commercial semantics. Assignment
publication to CR-HM-07 is a READ-ONLY resolver, not choreography.

## 8. BLOCKER CHECK

None. Every authority needed exists: target (PART 06 ACTIVATABLE
since `398c965`; runtime since `df9e41d`); provider/crew/Lead runtimes
(CR-HM-04 PART 01–03); lifecycle/audit/RBAC conventions (F8–F10);
same-Client validation seams (context-access); transactional/
partial-unique patterns (0393-class). The PART 04 STOP RULE is lifted
solely for `targetType=HANDYMAN_EXECUTION_SCOPE`.

**CR_HM_04_SCOPE_ASSIGNMENT_ACTIVATION=READY.**

## 9. FROZEN IMPLEMENTATION SEQUENCE (smallest; internal PARTs only)

- **PART A — persistence/invariants**: `handyman_execution_scope_assignments`
  + partial one-ACTIVE unique index + append-only/JOURNAL wiring;
  no HTTP. Gates: migrations additive; smuggling-proof inputs.
- **PART B — assignment semantics**: create/first-assign,
  atomic reassign-supersede (§4), `resolveHandymanAssignmentLead`
  public bounded resolver (§5), eligibility §1, zero side-effect proof.
- **PART C — minimum HTTP/OpenAPI** (only if operationally required):
  POST `/handyman/execution-scopes/:executionScopeId/assignment`,
  GET same path (current ACTIVE) + bounded lead-resolution subresource
  for CR-HM-07 wiring `.../assignment/lead-actor`; nothing else —
  no list/dashboard. Decide at PART B's end whether HTTP is needed at
  all; module-internal runtime must never depend on HTTP.
- **PART D — focused certification**: bounded-suite certification +
  CR-HM-07 unblock declaration (updates ONLY this doc's activation
  status + CR-HM-07 governance dependency note, by explicit mandate).

Each PART individually gated like CR-HM-06's (diff --check, focused
tests, no early implementation of later PARTs).

---
*This freeze activates ONLY the CR-HM-04 §3/§4 contract against
`HANDYMAN_EXECUTION_SCOPE` per PART 06 §2/§3. It changes no frozen
CR documents and no roadmap.*
