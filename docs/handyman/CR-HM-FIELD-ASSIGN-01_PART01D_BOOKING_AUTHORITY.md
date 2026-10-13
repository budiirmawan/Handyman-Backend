# CR-HM-FIELD-ASSIGN-01 PART 01D — Backend booking authority (verification + bounded change)

Baseline: `main` @ `634319c` (PR #21 merged). Branch: `arena/bdfa247a-handyman-backend`.
Repository guard: `budiirmawan/Handyman-Backend`, clean tree, HEAD verified before any edit.

**Status: PART 01D is NOT complete.** Verification and one bounded audit closure are delivered.
Customer-facing booking **confirmation remains disabled** (`confirmationEnabled: false`, `bookingEnabled: false`)
because the tenant identity and consent authority is unresolved (see Blockers).

## 1. Verified contract facts

Classification: **EXISTING** = implemented and wired; **PARTIAL** = implemented in part or DB-only;
**MISSING** = no authority in code; **AUTHORITY BLOCKED** = a business/security decision is required first.

| Contract | Class | Evidence (verified in source) |
|---|---|---|
| Operations visit proposal/read/cancel HTTP (`tenant_company.manage` / `.read`, session auth) | EXISTING | `handyman-visit-api.routes.ts`, mounted at `src/routes/index.ts:812` |
| Request-derived Client/Building/TenantCompany scope (never HTTP payload) | EXISTING | `requestScope()` in `handyman-visit-api.service.ts`; strict DTO in `handyman-visit-api.validation.ts` |
| Exact Building **and** Client scope for operator and proposed resource | EXISTING | `assertBuildingScopedResourceAccess`, `canAccessBuildingScopedResource` (PART 01B) |
| Inspector eligibility: ACTIVE user + registered EXTERNAL worker + vendor binding + Building placement | EXISTING | `findEligibleHandymanWorker` (continuation of PART 01B) |
| Inspector skill / qualification | MISSING / AUTHORITY BLOCKED | No qualification source exists (PART 01B blocker 1) |
| Crew eligibility: every ACTIVE membership revalidated, Lead must be ACTIVE linked user | EXISTING | `assertHandymanCrewWorkerEligibility`; execution proposal requires AUTHORIZED scope + ACTIVE crew assignment |
| Appointment state machine + version + provenance (DB) | PARTIAL | `0431` triggers: legal transitions, immutable identity/slot, version+1, cancel provenance |
| Live-uniqueness per request and visit kind | EXISTING | `handyman_visit_appointments_one_live_per_request_kind` (partial unique index) → HTTP 409 |
| Capacity reservation schema (no double booking, deferred two-way commit invariant) | PARTIAL | `0431`: `btree_gist` EXCLUDE constraint, deferred triggers require one active matching reservation for CONFIRMED/IN_PROGRESS |
| Capacity reservation **transaction** (lock, reserve, activate CONFIRMED, 23P01→409) | MISSING | No service or repository code reserves or activates capacity; `handyman-appointment.repository.ts` exposes proposal/read/attempt only |
| Authenticated tenant identity from BM Super App | PARTIAL → AUTHORITY BLOCKED | Handoff exchange → `BM_SUPER_APP` channel attribution only (`handoff-binding.service.ts`); D2 = "no automatic session" (`CR-HM-01_FINAL_VALIDATION.md`); no tenant session/principal in Handyman RBAC |
| Care actor as tenant representative | AUTHORITY BLOCKED | Care workspace principal is the integration-attested BM `CUSTOMER_CARE` actor (`CR-HM-CARE-WORKSPACE-01 PART01`); Care may submit a preference, never attest tenant consent (R1C handoff) |
| Tenant slot-choice provenance (`TENANT_SELECTED`, `tenant_choice_evidence_ref`) | MISSING | Column is free TEXT with no producer; no code sets `TENANT_SELECTED`. The R0/R1A docs state a string evidence ID is not valid consent |
| Existing quotation customer decision as slot consent | NOT REUSABLE | `handyman-quotation-decision.service.ts` stores `decidedByUserId = actorUserId` (the operator session), so it is operator-recorded, not tenant-authenticated, and covers a quotation version, not a slot |
| Confirmation idempotency and conflict | MISSING | No confirm endpoint. Proposal POST has no idempotency key; duplicates are stopped by the live-unique index (409) |
| Cancellation invariant (proposal) | EXISTING | `cancelVisitProposal`: only `PROPOSED`, current `version` required, request/client scope, else 409 |
| Cancellation of a CONFIRMED visit (reservation release) | MISSING | DB permits `CONFIRMED→CANCELLED`; no service path, no reservation release, no authority |
| Audit for visit proposal and cancel | **PARTIAL → closed in this PART** | Before: zero audit writes in the visit service. After: same-transaction `recordOperationalEvent` (see §2) |
| Audit for result/quotation decisions | EXISTING | Unchanged (PART 01B result; `handyman-quotation-decision.service.ts`) |

## 2. Implemented change (bounded)

`src/modules/handyman-appointment-contract/handyman-visit-api.service.ts` only:

- `createVisitProposal` writes `HANDYMAN_VISIT_PROPOSED` (entity `HANDYMAN_VISIT_APPOINTMENT`, actor = session user,
  metadata = request id, kind, resource, execution scope, slot, `state: PROPOSED`, version).
- `cancelVisitProposal` writes `HANDYMAN_VISIT_PROPOSAL_CANCELLED` after the guarded UPDATE.
- Both use the existing `recordOperationalEvent(…, tx)` seam, so the audit commits or rolls back with the mutation.
  No new table, migration, endpoint, permission, status, or response-shape change.
- Metadata carries no tenant consent, caller-supplied context, or booking/capacity claim.

Not changed: Handyman-Mobile, Freelancer registration, FM Work Orders, Crew assignment semantics, Work Session,
Inspector result authority, migrations, `openapi.yaml`, eligibility/RBAC/scope logic.

## 3. Tests

`tests/handyman-visit-booking-authority.test.ts` (7 cases; real router, session/RBAC middleware, real service,
isolated TEMP PostgreSQL fixtures):

1. Successful proposal is PROPOSED-only and writes exactly one same-transaction audit row with the correct actor, entity, Client and Building; metadata has no consent/booking keys.
2. Duplicate live proposal for the same request and kind returns 409 with no second row or audit.
3. Audit write failure rolls the proposal back (no partial visit, no audit).
4. Cancel requires the current version. Stale → 409 with no audit; current → CANCELLED, version 2, one cancel audit.
5. Cancel refuses a non-PROPOSED row (409) and writes no audit.
6. The visit router exposes exactly the three proposal/read/cancel routes (no select-slot, confirm, or reschedule).
7. Confirmation-style paths (`confirm`, `select-slot`, `reschedule`) return 404 and leave the row untouched.

Evidence:
- Against the original service, 6 of 7 cases fail (audit and cancel-audit cases; route-surface case passes by design). Fixed source restored byte-for-byte.
- Focused run: **108/108 pass, zero skips**. This is 101 baseline cases across `handyman-inspector-authority`, `handyman-crew-worker-admission`, `handyman-visit-r1c/proposal-validation`, `handyman-appointment-persistence`, `handyman-appointment-core`, and `handyman-audit-integration-part03`, plus the 7 new cases.
- `npm run typecheck` passes.
- No full suite, no migration, no deploy, no PR.

## 4. Confirmation decision

**DISABLED.** Activation requires ALL of the following. Only the first two are blocking business or security decisions; the rest are engineering work.

| # | Condition | Status | Minimum contract needed |
|---|---|---|---|
| 1 | Authenticated tenant identity for slot choice | **AUTHORITY BLOCKED** | Decide the channel. Either (a) BM Super App sends a signed, single-use, server-verified tenant-slot assertion carrying the tenant PIC, tenant company, building/space, request id, appointment id, appointment version, kind, exact slot and expiry; or (b) an explicitly approved assisted-consent policy with independent proof. Care cannot act as tenant. |
| 2 | Verified tenant-selected slot and consent provenance | **MISSING** | Append-only `tenant_slot_choices` record (or an approved reuse of an existing evidence authority) binding actor type, represented tenant/PIC, method, appointment id and version, exact slot, nonce, expiry and proof reference. Transition PROPOSED→TENANT_SELECTED consumes it. The free-text `tenant_choice_evidence_ref` is not sufficient. |
| 3 | Eligible resource | PARTIAL | Inspector registration/placement exists. Inspector skill/qualification source still needed (PART 01B). Crew eligibility exists. |
| 4 | Atomic capacity reservation | PARTIAL (schema) / MISSING (transaction) | Confirm transaction that locks the appointment, inserts the active reservation, and sets CONFIRMED with `confirmed_by`/`confirmed_at` together. SQLSTATE 23P01/23514 mapped to stable 409. The schema already enforces the invariant. |
| 5 | Transactional idempotency, conflict and audit | MISSING (confirm) | Confirm endpoint with an idempotency key (`request-idempotency` substrate, CR-BE-STAB-01), version gate, and in-transaction audit following §2. |
| 6 | Exact request/client/building scope | EXISTING | Reuse `requestScope` and `assertBuildingScopedResourceAccess`. |
| 7 | Cancellation of CONFIRMED visits | MISSING | Separate authority: release reservation and cancel atomically, with version and audit. |

Permit and site-access gates belong to VISIT_START under R1A (`evaluateHandymanAppointmentAdmission`, `phase='VISIT_START'`) and do not block booking.

## 5. Preserved boundaries

- Tenant determines the date/time: the proposal is a Handyman suggestion only. Nothing here chooses a slot for the tenant.
- INSPECTION and EXECUTION remain separate kinds, with separate resource types and scopes.
- PROPOSED is not CONFIRMED. Crew ACTIVE does not imply booking. No tenant consent or reservation record was invented.
- Repository-level `handyman-appointment.repository.ts` primitives are not exposed to HTTP.

## 6. Notes

- `node_modules/` is not ignored by this repository's `.gitignore` and shows as untracked after `npm ci`. It was **not** committed. Adding it to `.gitignore` is a repository-hygiene decision outside this PART.
- The `docs/handyman-e2e/*` R1B/R1C handoffs describe ZIP snapshots. They are consistent with branch state (migration `0431` exists, no confirm route), but they predate this PART's verification.
