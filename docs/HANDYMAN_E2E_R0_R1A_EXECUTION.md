# HANDYMAN — E2E R0 Authority Reconciliation + R1A Appointment Core

**12 October 2026 · Status: R1A PARTIAL IMPLEMENTATION, NOT LIVE BOOKING**

Source baseline: user-uploaded `Handyman-Backend-main.zip`. This deliverable deliberately **does not modify the frozen Handyman roadmap, CR-HM-03 inspection result semantics, or CR-HM-05 scheduling readiness**. It adds a standalone policy-neutral appointment *pre-admission* core and focused tests. No new migration, route, live permission, production configuration, deployment, or commit/push has been performed.

## 1. Exactly what was implemented

- `src/modules/handyman-appointment-contract/handyman-appointment-core.ts` — pure TypeScript, separate `INSPECTION` and `EXECUTION` purposes; checks request/tenant scope, chosen window, server-verified consent reference, inspector/crew eligibility, approved-quote precondition for execution, overlapping resource capacity, and visit-start permit/site access conditional on resolved building policy. No payment policy is imposed and no result is written.
- `tests/handyman-appointment-core.test.ts` — 19 focused positive/negative cases, including incomplete/wrong tenant consent, invalid local-time timestamps, adjacent slots, resource conflicts, attempted reschedule without matching consent, ineligible worker, and no-show that cannot consume frozen final inspection result.
- The code is **not registered in the existing production router**. The `verifiedByServer` field is a placeholder for server-derived consent facts, **not** a valid client JSON field or a cryptographic consent proof. `existingResourceBookings` must come from a DB query protected by transaction/exclusion before live use.

Validation performed:

```bash
node --experimental-strip-types --test tests/handyman-appointment-core.test.ts
# 19/19 PASS on Node v22.16

tsc --noEmit --strict --target ES2022 --module commonjs --lib ES2022,DOM --skipLibCheck \
  src/modules/handyman-appointment-contract/handyman-appointment-core.ts
# PASS
```

**Not done:** npm full project typecheck/build (npm dependencies absent from extracted ZIP), PostgreSQL migration checks, HTTP/integration/device E2E. This is not an implementation of confirmed booking or a reservation guarantee.

## 2. Business authority and separated lifecycles (R0 decision-ready mapping)

| Boundary | One authoritative action | Persona | Never treat as |
|---|---|---|---|
| Triage | `onsite inspection required` or justified remote diagnosis | Operations | Auto-booking an inspection |
| Inspection slot choice | Authenticated tenant/PIC choice, or proven assisted authorization | Tenant/PIC | Customer Care consent |
| Inspection confirmation | Eligible inspector, reserved non-overlapping slot, exact unit/building | Operations | Mere preferred time window |
| Inspection attempt | Real arrival/access/checklist/evidence, NO_SHOW and BLOCKED attempts kept separately | Inspector | Immutable final inspection result |
| Inspection result | Final authorized result appended once under CR-HM-03 | Existing Backend authority | Multiple visit attempts / automatic NOT_INSPECTABLE policy change |
| Quotation | Current scoped version with authenticated tenant decision | Tenant/PIC | Care approval |
| Execution slot choice | Tenant selects post-quotation schedule | Tenant/PIC | Inspection slot reused |
| Execution confirmation | Reserved crew capacity, material/dispatch readiness | Operations | Preferred-window readiness record |
| Execution start | Fresh effective permit/access + arrival/Lead authority | Backend/Lead | Frontend-only button visibility |
| QC + BAST | Supervisor PASS → provider issues BAST → authorized recipient acceptance | Supervisor/provider/recipient | Crew self-QC automatically equal PASS |
| Payment | Care reports; Finance or entitled verifier confirms actual provider collection | Care/Finance | Care marking invoice PAID |
| FINAL CLOSE | Audited manager-only command with current guards | Handyman Manager | Dispatcher click / payment auto-close |
| Post close | Warranty, BM fee, settlement, corrections independently continue | Relevant role | Implicit terminal lifecycle |

BM Super App stays an access channel. Handyman owns the authoritative lifecycle. Work Crew Mobile is for Lead Worker/Inspector visit experiences, not Customer Care or Finance authorization.

## 3. Backend-specific evidence and containment

1. `src/modules/handyman-requests/handyman-request-inspection.service.ts` uses an immutable one-per-request result (`INSPECTION_REQUIRED -> DIAGNOSIS`), including `NOT_INSPECTABLE`; do not change this frozen behavior without explicit scoped CR.
2. `src/database/migrations/0381_create_handyman_request_inspections.ts` enforces UNIQUE(request). New rebooking/attempts MUST NOT write to this table as visits.
3. `src/modules/handyman-scheduling/handyman-scheduling.service.ts` clearly states READINESS ONLY and explicitly does not reserve crew or produce a work order. Booking must be separate.
4. `src/modules/handyman-bast-api/handyman-bast-api.routes.ts` intentionally excludes provider `prepare`/`issue` HTTP. Its exposure requires bounded CR + provider entitlement and latest-QC checks, not a generic manage-permission route.
5. `src/modules/handyman-customer-ledger-api/handyman-customer-ledger-api.routes.ts` uses broad existing manage permission for payment actions; distinct Finance verification vs Care report requires an explicit capability and service guard.
6. Operations demo state/localStorage and Frontend demo state are not shared DB E2E evidence; Operations production runtime still needs a real backend adapter.

## 4. Proposed persistent backend authority (R1B, NOT IMPLEMENTED)

**Decision proposal**, not a frozen schema:

- `inspection_visits`: UUID id; reference request/tenant/building/unit; inspector id; tenant-selected slot reference; confirmed start/end/timezone; state/version; creator/confirm actor; immutable audit refs; timestamps. Can have multiple visits/attempts per request; never replaces single final inspection row.
- `inspection_visit_attempts`: append-only id, visit id, actual inspector, arrival/access evidence, outcome, timestamps, reason. `NO_SHOW`, `ACCESS_BLOCKED`, `REBOOK_REQUIRED` cannot create final inspection result automatically.
- `execution_appointments`: separate UUID, accepted quotation version, authoritative execution scope/crew assignment, tenant slot decision, effective confirmed slot, cancel/reschedule/version.
- `resource_capacity_reservations`: resource ID (inspector or eligible crew capacity), appointment purpose+id, `tstzrange` window, active/inactive status. Confirm atomically with exclusion guarantee (`btree_gist` + `EXCLUDE USING gist` or equivalent serialization strategy); SQLSTATE overlap/serialization must become stable 409, not soft UI-only conflict detection.
- `tenant_decision_evidence`: reuse an existing verified consent/evidence authority when possible, otherwise separate minimal immutable record. Must distinguish actor, represented tenant/PIC, method, exact quoted/slot version, nonce/expiry and proof. Client-provided `verifiedByServer:true` must always be ignored.
- Scope: server derives building/unit/tenant from request; inspector from authorized company/worker assignment; never from unsafe Care input. Read and write use building-level isolation; do not give Crew Lead blanket `tenant_company.read`/`manage`.
- Rule resolution: appointment can be booked while external permit is pending. Visit check-in/start may be denied by effective building/visit-type rules; invalid/unknown policy fails closed **at start**. Commercial inspection fee is never automatically charged without an explicit approved policy.

## 5. Candidate HTTP contract (for explicit scoped CR review only)

This is a *proposed consumer contract*, **not registered routes**.

| Method / path candidate | Actor | Required backend authority |
|---|---|---|
| `GET /handyman/requests/:id/inspection-visit-slots` | Tenant/Care/Ops | Authorized request & building read; derived eligibility/calendar |
| `POST /handyman/requests/:id/inspection-visits` | Ops | Create *proposal*, not confirmed booking |
| `POST /handyman/inspection-visits/:id/select-slot` | Tenant / verifiably assisted flow | Authenticated tenant choice / attested proof; version gate |
| `POST /handyman/inspection-visits/:id/confirm` | Ops | Atomic exclusive inspector capacity; conflict 409; exact choice/version |
| `POST /handyman/inspection-visits/:id/check-in` | Assigned inspector | Arrival, site permit/access readiness, current assignment |
| `POST /handyman/inspection-visits/:id/attempts` | Assigned inspector | Real visit evidence, idempotency; failed attempts do not consume final result |
| `POST /handyman/inspection-visits/:id/reschedule` | Tenant + Ops distinct phases | New tenant proof, stale versions denied, old reservation released safely |
| `GET/POST /handyman/requests/:id/execution-appointments` | Tenant/Ops | Approved quotation version; separate execution booking & capacity |
| `POST /handyman/execution-appointments/:id/confirm` | Ops | Crew/material/slot admission & atomic lock; tenant choice |

Request body must not be able to impersonate a tenant, inspector or Finance verifier. Decisions must be traceable through record IDs and DB audit; API descriptions are not authority by themselves. A backend derived read projection should expose linked IDs to all four repos.

## 6. Product decisions still needed before R1B writes

- Inspection fee/free/no-show charges/credit to later quotation. **Interim safe policy: no automatic financial posting from appointment.**
- Exact tenant verification channels; assisted Care consent needs independent proof. **Interim safe policy: prohibit unverified Care sign-off.**
- Inspector role eligibility: dedicated inspector vs eligible Lead Worker assigned to an inspection visit. Can reuse person identity, not execution session as inspection.
- Effective property-specific permit/access rule matrix and exceptional overrides.
- Whether `NOT_INSPECTABLE` is a legitimate final diagnosis or a failed visit requiring another attempt. Frozen CR-HM-03 behavior remains untouched until explicitly amended.
- No-show threshold, reschedule limits, prior-slot release, current-version proof and exception authority. **Interim safe policy: audit all changes; no automatic fee/cancel based on unknown thresholds.**
- BAST signer/delegation proof, backup Finance verifier and separation-of-duties, payment/chargeback/reopen policy for R1C/R1D.

## 7. Next safe execution order

**R1B (Backend appointment persistence, scoped CR):** approve minimum business authority; implement migration and transactionally confirmed inspection+execution visit records, tenant consent, exact building/role scope, SQL capacity exclusion, idempotency/409. Do NOT silently alter CR-HM-03 and CR-HM-05. Focused transaction tests include concurrent same inspector bookings, foreign-building denial, two appointment types and failed attempts.

**R1C (Backend execution and BAST):** visit check-in/permit guards, separate inspector and crew read models, provider prepare/issue transport only with correct entitlement and QC binding, verified recipient sign-off.

**R1D (Backend finance and closure):** Care reports payment evidence; Finance verifies independently; invoice PAID derived from ledger and outstanding; Handyman Manager-only audited CLOSE in one transaction with latest QC/BAST/invoice and unresolved exception guards.

**R2–R4:** wire Operations calendar/Finance/Manager to production Backend; Tenant/Care two calendars, quotation decision and reports; Mobile My Inspection Visits and My Execution Jobs with scoped offline proof/evidence. No demo localStorage writes to live state.

**R5:** 18 E2E scenarios from consolidated gap review on the SAME migrated Postgres + BE and real browser/device identities. Build and migrations must be measured, not assumed.

## 8. Current implementation's strict limits

- No client can currently create an appointment through R1A.
- `evaluateHandymanAppointmentAdmission(..., 'BOOKING')` only evaluates input facts; it **cannot reserve capacity**. Two concurrent confirmations can both pass preflight, so PostgreSQL locking/constraint is essential in R1B.
- `evaluateHandymanAppointmentAdmission(..., 'VISIT_START')` additionally requires effective permit/site access policy. That means permit must not be skipped merely because arrival passed.
- `isEligibleFinalInspectionAttempt` is a negative-invariant guard. It DOES NOT authorize calls into frozen `recordHandymanInspection` and is not wired into it.
- 19 focused contract tests PASS; repo-wide build and real DB-backed E2E remain **UNVERIFIED**.

## 9. Handoff for same-branch Arena implementation

1. Start from current live Arena branch, verify branch/HEAD/tree/remote and compare against uploaded ZIP snapshot. Reconcile new code with actual active branch rather than force replacing it.
2. Import the isolated source/test files only if the module does not already exist. Keep frozen CR-HM-03 and CR-HM-05 untouched; no re-numbering.
3. Follow the R1B scoped policy decision; write migration safely, compare with existing latest migration numbers, and avoid guessing the next ID.
4. Validate focused tests, `npm run typecheck` if dependencies available, and targeted migrated Postgres tests. Report any ENV_BLOCKED honestly.
5. Commit and push every safe bounded step to the SAME current Arena branch; continue without arbitrary pause, stop only for a substantive authority decision or unsafe blocker. No PR, merge, force-push or deploy implicitly.
