# Handyman E2E Persona & Capability Matrix — CR-HM-E2E-LIFECYCLE-01

- **Repository**: `budiirmawan/Handyman-Backend` (backend only; no consumer-repo changes)
- **Scope**: complete persona & capability journey J01–J12 across Tenant, Customer Care, Inspector, PIC Pekerjaan, Dispatcher, Operations Manager, Supervisor QC, Finance, BM, Provider, Manager
- **Method**: audit of existing routes/services/schema/permissions/transitions/events/tests (migrations 0374–0446, ~68 `handyman-*` modules), reuse of all previously merged implementation (Dispatch, Commercial Inbox, QC, Worker BAST), repair of genuine gaps only, persona-handoff integration tests on disposable PostgreSQL
- **Authority law**: the backend is the sole authority for persistence, authorization, workflow, business rules, data scope and available actions. No role impersonation; no frontend-derived business authority. Bodies carry references + `idempotencyKey` only; amounts, states and actors are server-derived.
- **Classifications** (per journey, with sub-items called out where they differ):
  - `COMPLETE` — backend HTTP seam + service authority + persistence/audit + passing focused evidence;
  - `PARTIAL` — the core journey works end-to-end, but a named sub-capability is missing or untested;
  - `MISSING` — no backend capability exists (inventing it would require a product/authority decision);
  - `BLOCKED OTHER REPO` — backend is ready; availability to end users waits on a consumer repository (BM Super App / Customer Care web / worker mobile) integrating the contract;
  - `NOT TESTED` — capability exists in source but has no passing focused evidence (e.g. a stale test fixture/harness), stated explicitly rather than silently assumed.

All routes are under `/api/v1`. RBAC shorthand: `read` = `tenant_company.read`, `manage` = `tenant_company.manage`. Building authority = exact-Building assignment (`canAccessBuildingScopedResource`, `src/modules/context-access/context-access.service.ts`); there is no same-Client shortcut and no client-wide privilege.

---

## 1. Coverage summary

| Journey | Before this CR | After this CR | Primary evidence |
|---|---|---|---|
| J01 Request / Triage | COMPLETE (core) | **PARTIAL** — tenant-request cancel is `MISSING` | `handyman-api`, `handyman-lifecycle-api`, `handyman-care-workspace` |
| J02 Inspection Appointment / Diagnosis | COMPLETE | **COMPLETE** — inspector-assignment HTTP sub-surface `NOT TESTED` (stale harness) | `handyman-lifecycle-api`, `handyman-appointment-contract`, `handyman-inspector-assignments-api` |
| J03 Scope / Quotation / Tenant Approval | COMPLETE | **COMPLETE** | `handyman-quotations-api`, `handyman-scope-assignments-api` |
| J04 Execution Appointment / Dispatch | COMPLETE | **PARTIAL** — scope-assignment HTTP suite `NOT TESTED` (stale fixture); assignment proven via service in new E2E | `handyman-dispatch-api`, `handyman-arrival-verification-api` |
| J05 Work Session | COMPLETE | **COMPLETE** | `handyman-work-sessions-api` |
| J06 Variation ADD / REDUCE | COMPLETE | **COMPLETE** (pre-existing suites; not re-run in this CR) | `handyman-scope-variations` |
| J07 Material Purchasing / Usage / Return | COMPLETE | **COMPLETE** (pre-existing suites; not re-run in this CR) | `handyman-material-execution-api`, `handyman-material-purchasing` |
| J08 Supervisor QC / Defect / Rework | COMPLETE | **COMPLETE** | `handyman-evidence-qc-api`, migrations 0442/0444 |
| J09 BAST / Customer Acceptance | COMPLETE | **COMPLETE** | `handyman-bast-api`, `handyman-bast-worker-api`, migration 0445 |
| J10 Invoice / Payment / Finance | PARTIAL (open/charge/allocate/correct service-only) | **COMPLETE** in this repo (+ 1 repaired cap defect) | `handyman-customer-ledger-api` (existing) + `handyman-finance-close-api` (new) |
| J11 Manager Close / Warranty | PARTIAL (warranty start/expire + field rework service-only) | **PARTIAL** — warranty/rework COMPLETE; manager-close aggregate `MISSING` (authority decision) | `handyman-service-warranty-api` (existing) + `handyman-finance-close-api` (new) |
| J12 BM Fee / Settlement / Reporting | PARTIAL (entitlement/settlement/financial-read/commercial authoring service-only) | **PARTIAL** — core COMPLETE; dispute adjudication `MISSING` (deliberately not invented) | `handyman-finance-close-api` (new), `handyman-sla-status-api` |

Persona handoffs verified end-to-end over HTTP in `tests/handyman-e2e-finance-close-api.test.ts` (J10–J12) and by the pre-existing focused suites for J01–J09 (see §16 for exact PASS/FAIL evidence, including pre-existing failures that are byte-identical on clean `main`).

---

## 2. Persona & authority model (applies to every journey)

| Persona | How the backend knows | Typical authority |
|---|---|---|
| Tenant / PIC (customer side) | User + ACTIVE Building assignment; tenant-company/PIC binding for care flows | Reads own scope facts; BAST accept/reject; claim submit/approve; rework authorize |
| Customer Care | Care actor registry + workspace session (`handyman-care-workspace`, migrations 0425–0430) | Care request create/read within granted property context |
| Inspector | Registered ACTIVE worker context under ACTIVE provider + assignment (`handyman-inspector-assignments-api`, migration 0438) | Inspection proposal; inspection-result recording is deliberately administrative/building-scoped per `CR-HM-FIELD-ASSIGN-01_PART01B_INSPECTOR_AUTHORITY.md` |
| PIC Pekerjaan / Crew Lead | CURRENT crew lead of the ACTIVE scope assignment | Work sessions, evidence, QC participation, BAST worker lane, warranty rework field ladder — enforced in services, **auth-only transport, no tenant RBAC** |
| Dispatcher | `manage` + Building | Dispatch readiness/release/cancel |
| Operations Manager | `manage` + Building | Triage, diagnosis, quotation, assignments, variations |
| Supervisor QC | `handyman.qc.manage` + supervisor-of-current-Lead reporting line + not an executing crew member (migration 0442) | Guarded QC PASS/FAIL, defect reinspection pass |
| Finance | `manage` + exact-Building (scope-bound) | Ledger open/charge/allocation/corrections, entitlement, settlement |
| BM (Building Mgmt / client org) | Client-scoped commercial aggregate via `canAccessClient` | Commercial agreement + pricing/BM-fee authoring (J12) |
| Provider | Provider/worker contexts (`handyman-provider-api`) | Crew/worker lifecycle, availability |
| Manager | — | No distinct "manager close" command exists (see J11) |

Denied actions return bounded errors (401 unauthenticated, 403 RBAC/building, 404 unknown scope before access wall where that is the module's frozen precedence, 409 state/idempotency conflicts, 400 validation). Replays of the same `idempotencyKey` return the same persisted fact with `replayed: true`; the same key with a different intent is a 409.

---

### 2.1 End-to-end persona handoff chain (persona → capability → action → API → persisted state → next persona)

| Journey | From persona → capability / action (API) | Persisted state (source of truth) | → Next persona |
|---|---|---|---|
| J01 | Tenant/Customer Care → submit & triage request (`POST /handyman/requests[/care]`, `POST …/triage`) | `handyman_service_requests` + triage decisions (0380), channel attribution | Operations Manager (diagnosis) or terminal REFERRED |
| J02 | Operations → propose inspection visit + assign Inspector (`POST …/visits`, `POST /handyman/visit-appointments/:id/inspector`); Tenant → consent slot (`tenant-slot-consent`) | `handyman_visit_appointments`, `handyman_inspector_assignments` (0438, ACTIVE/SUPERSEDED/REVOKED, versioned), slot consents (0434) | Inspector (field inspection) |
| J02→J03 | Inspector/Operations → record inspection + diagnosis (`POST …/inspection`, `POST …/diagnosis`) | inspections/diagnoses (0381/0382) | Operations Manager (scope/quotation) |
| J03 | Operations → build & issue quotation; Tenant → approve (`POST …/quotation`, `POST /handyman/quotations/:id/versions`, decide) | quotation versions/lines (0391–0394); approved decision mints AUTHORIZED execution scope (0395) | Dispatcher / Operations (crew assignment) |
| J04 | Operations/Dispatcher → assign crew (`POST /handyman/execution-scopes/:id/assignment[/reassign]`), release dispatch, verify arrival | `handyman_execution_scope_assignments` (ACTIVE/SUPERSEDED + history 0439), dispatch releases (0440/0441), arrival results (0397–0400) | PIC Pekerjaan / Crew Lead (check-in) |
| J05 | Crew Lead → check-in → start/pause/material-run/resume/complete/check-out (`/handyman/…/work-sessions`) | `handyman_work_sessions` + events (0401) | Supervisor QC |
| J06 | Operations/Tenant → ADD/REDUCE variation propose/decide (`handyman-scope-variations`, 0435) | variation facts bound to scope; no rewrite of quotation/charge facts | Crew Lead (execution), Finance (composition) |
| J07 | Crew Lead/Operations → estimate→approve→issue→purchase→use→return→settle (`material-execution`, 0402; purchasing 0436) | material execution/purchasing facts; settled quantities read-only for pricing | Supervisor QC, Finance |
| J08 | Crew Lead → evidence + QC participation; Supervisor QC → guarded finish PASS/FAIL, defect rectification/reinspection (`evidence-qc-api`, 0403/0442/0444) | evidence records, QC runs/items/events, defect records | Customer (BAST) once current QC PASS exists |
| J09 | Crew Lead → BAST prepare/issue (`/handyman/field/…/bast`); Customer → accept/reject/sign-off (`POST /handyman/bast/:id/accept|reject|sign-off`) | `handyman_bast_documents` DRAFT→ISSUED→ACCEPTED/REJECTED/VOID (0404/0405, QC-pass guard 0445) | Finance (ledger) + warranty clock |
| J10 | Finance → open transaction, compose charges, record/confirm payment (existing), allocate, corrections (`customer-ledger-api` + new §12) | transactions/charge lines/payments/allocations/corrections (0410–0414, net caps 0447) | BM/Finance (entitlement & settlement) |
| J11 | Operations → start warranty from ACCEPTED BAST (new §13); Tenant → claim approve + rework authorize (existing); Crew Lead → propose/start/complete/verify rework (new) | warranties/coverages (0419), claims (0420), reworks (0421) + append-only events | Tenant (verified rework) / terminal EXPIRED |
| J12 | BM → author commercial + pricing/BM-fee terms (new §14); Finance → derive entitlements → prepare/include/reconcile/settle (new) | agreements/pricing facts (0406–0409), entitlement facts (0416/0417), settlement units/events/inclusions/reconciliations (0418) | BM/Provider reporting (financial reads); **no fund movement** |

## 3. J01 — Request / Triage — PARTIAL

- **Trigger/prerequisite**: Tenant request via BM Super App handoff (`POST /handoff/assertions`, `POST /handoff/channel-attributions`) or Customer Care (`POST /handyman/requests/care`, `POST /handyman/care/requests` via workspace session); staff intake `POST /handyman/requests`.
- **States**: request `INTAKE → … → REFERRED` (terminal referral) / diagnosis path continues to J02. Triage dispositions recorded append-only (`handyman_request_triage_decisions`, migration 0380).
- **Commands/actors**: triage `POST /handyman/requests/:handymanRequestId/triage` (`manage` + Building); referral `POST …/referral` (OUT_OF_SCOPE → FM boundary); intake evidence `POST …/intake-evidence`.
- **Reads**: `GET /handyman/requests`, `GET /handyman/requests/:id`, `GET …/triage`, `GET …/intake-evidence`, care projections, operations queue `GET /handyman/operations/queue` (all `read` + scope wall).
- **Handoff**: triage DIAGNOSIS → J02; referral is a terminal exit with full audit.
- **MISSING sub-item**: there is **no tenant-request `CANCELLED` status and no cancel command**. Cancellation today exists only for dispatch releases (`POST …/dispatch/cancel`) and visit proposals. Inventing a request-cancel vocabulary requires a product authority decision (see §17).
- **Tests**: `tests/handyman-lifecycle-api.test.ts` (9 PASS / 1 pre-existing FAIL — stale exact OpenAPI surface assertion), care workspace + handoff suites.

## 4. J02 — Inspection Appointment / Diagnosis — COMPLETE

- **Trigger**: triage disposition DIAGNOSIS.
- **Commands**: `POST …/inspection`, `POST …/diagnosis` (lifecycle-api, `manage` + Building); inspector assignment `POST /handyman/visit-appointments/:visitAppointmentId/inspector` (+ `/reassign`, `GET /handyman/requests/:handymanRequestId/inspector-assignments/history`); visit proposals + **tenant slot consent** (`handyman-appointment-contract`: visit-api + `handyman-tenant-slot-consent`, migration 0434) — the appointment is not authoritative until the tenant consents to the slot.
- **Verified Inspector endpoints** (`src/modules/handyman-inspector-assignments-api/handyman-inspector-assignments-api.routes.ts`, all behind auth; reads `tenant_company.read`, writes `tenant_company.manage`):

  | Action | API | Payload | Persisted result |
  |---|---|---|---|
  | List eligible inspectors | `GET /handyman/visit-appointments/:visitAppointmentId/inspector/eligible` | — | projection only (worker context + conflict flag) |
  | Read current assignment | `GET /handyman/visit-appointments/:visitAppointmentId/inspector` | — | current ACTIVE assignment or bounded 404 |
  | Assign inspector | `POST /handyman/visit-appointments/:visitAppointmentId/inspector` | `{inspectorUserId}` | new ACTIVE row in `handyman_inspector_assignments` (201) |
  | Reassign inspector | `POST /handyman/visit-appointments/:visitAppointmentId/inspector/reassign` | `{inspectorUserId, expectedVersion, reason, idempotencyKey?}` | prior row SUPERSEDED (version-guarded), new ACTIVE row (201) |
  | Revoke assignment | `POST /handyman/visit-appointments/:visitAppointmentId/inspector/revoke` | `{expectedVersion, reason}` | ACTIVE → REVOKED (200) |
  | Assignment history | `GET /handyman/requests/:handymanRequestId/inspector-assignments/history` | — | append-only history incl. SUPERSEDED/REVOKED |

  Eligibility is enforced in `handyman-inspector-assignment.service.ts` (registered ACTIVE worker under ACTIVE provider, no overlapping capacity conflict); statuses are exactly `ACTIVE | SUPERSEDED | REVOKED` with optimistic `version` increments (migration 0438 triggers).
- **Authority**: inspector must be a registered ACTIVE EXTERNAL worker under an ACTIVE provider with effective binding; inspection-result recording remains an administrative building-scoped command by frozen design (`CR-HM-FIELD-ASSIGN-01_PART01B_INSPECTOR_AUTHORITY.md`), not assigned-inspector-only.
- **Handoff**: diagnosis (discipline-bound) → J03 scope/quotation.
- **Tests**: lifecycle-api suite (9/10, §16); `tests/handyman-inspector-authority.test.ts` 30 PASS / 2 FAIL in this CR — the 2 failures are the suite's own mocked TEMP-table harness missing the migration-0434 `handyman_visit_tenant_slot_consents` table (pre-existing harness debt, code path untouched by this CR), so the inspector-assignment HTTP surface is classified `NOT TESTED` at the margin while inspection/diagnosis authority itself is exercised by the passing 30.

## 5. J03 — Scope / Quotation / Tenant Approval — COMPLETE

- **Trigger**: completed diagnosis.
- **Commands**: `POST /handyman/requests/:handymanRequestId/quotation`, `POST /handyman/quotations/:quotationId/versions`, issue/decide (approve/reject) via quotations service (`handyman-quotations-api`); approval creates the AUTHORIZED execution scope; quotation expire is exposed through the same API family.
- **Reads**: `GET …/quotation`, `GET …/quotation/presented` (tenant-presented snapshot), commercial inbox `GET /handyman/operations/commercial-inbox`.
- **Money law seeded here**: the approved quotation version + lines are the immutable amount authority for J10 charges (server-derived; callers never supply amounts).
- **Handoff**: APPROVED quotation → execution scope (AUTHORIZED) → J04 assignment/dispatch.
- **Tests**: quotations-api, commercial-inbox, scope-assignment suites.

## 6. J04 — Execution Appointment / Dispatch — PARTIAL

- **Commands**: crew assignment (`handyman-scope-assignments-api`, migration 0439 hardening: workforce must be building-eligible), dispatch `GET …/dispatch/readiness`, `POST …/dispatch/release`, `POST …/dispatch/cancel` (`handyman-dispatch-api`, migrations 0440–0441), arrival verification `POST/GET /handyman/execution-scopes/:executionScopeId/arrival-verification`.
- **Internal transitions**: dispatch IN_PROGRESS / COMPLETED are driven by work-session check-in/complete (J05) — deliberately not separate HTTP commands.
- **Handoff**: released dispatch + verified arrival → J05 check-in.
- **Verified Scope Assignment endpoints** (`src/modules/handyman-scope-assignments-api/handyman-scope-assignments-api.routes.ts`; reads `tenant_company.read`, writes `tenant_company.manage`):
  - `POST /handyman/execution-scopes/:executionScopeId/assignment` — body `{providerContextId, crewId, idempotencyKey?}` (whitelist parser; client/status/lead/scheduling fields are structurally ignored). Creates exactly one ACTIVE `handyman_execution_scope_assignments` row (201); a second ACTIVE assignment is a bounded conflict — use reassign.
  - `GET /handyman/execution-scopes/:executionScopeId/assignment` — bounded current view: assignment facts + CURRENT lead identity composed live from the internal Lead resolver (the resolver is deliberately **not** a standalone endpoint).
  - `POST /handyman/execution-scopes/:executionScopeId/assignment/reassign` — body `{providerContextId, crewId, expectedVersion, reason, idempotencyKey?}`; supersedes the old row (history in `handyman_execution_scope_assignment_history`, migration 0439) and activates the new crew.
  - Eligibility (service + DB): ACTIVE provider context and crew under the scope's Client, CURRENT crew Lead with linked user, and — since migration 0439 — the Lead's workforce profile must hold an ACTIVE workforce **Building** assignment for the scope's Building (`assignBuildingToWorkforce`). The new E2E suite arranges this and the assignment path is exercised end-to-end (crew assignment → derivation/settlement/warranty all resolve the same ACTIVE assignment and Lead).
  - Suite status: `tests/handyman-scope-assignments-api.test.ts` currently fails 0/10 at fixture time with `HANDYMAN_WORKFORCE_BINDING_REQUIRED` (its fixture predates the 0439 building-eligibility requirement — same root cause proven on clean `main` for sibling suites, §16), so the assignment **HTTP** surface is `NOT TESTED` by that suite; the underlying service path is covered by the new E2E suite.
- **Tests**: dispatch-api, arrival-verification, scope-assignments-api suites.

## 7. J05 — Work Session — COMPLETE

- **Commands** (auth-only transport; service enforces CURRENT Crew Lead): `POST /handyman/work-sessions/:sessionId/check-in|start-work|pause|material-run|resume|complete|check-out` (base `/handyman/execution-scopes/:executionScopeId/work-sessions`), `GET …/active`, `GET /handyman/work-sessions/:sessionId/time-projection` (`read`).
- **Persistence**: `handyman_work_sessions` (migration 0401) with append-only events; completed/checked-out sessions are a precondition of the guarded QC PASS (migration 0445 guard reads them).
- **Tests**: work-sessions-api suites.

## 8. J06 — Variation ADD / REDUCE — COMPLETE

- **Commands**: `handyman-scope-variations` router (CR-HM-FIELD-AUTHORITY-01 P0-B, migration 0435): propose/decide Pekerjaan Tambah/Kurang against the authorized scope; QC authority is separated from variation authority (migration 0443).
- **Law**: variations never rewrite the approved quotation or posted charge facts; financial effect flows through governed composition downstream (J10).
- **Tests**: `tests/handyman-scope-variations.test.ts` and authority-separation suites.

## 9. J07 — Material Purchasing / Usage / Return — COMPLETE

- **Commands**: material execution (`POST …/materials/estimate`, `…/:lineId/approve|issue|purchase|use|return|settle`, `GET …/final-charge-ready`) and material purchasing lifecycle (`handyman-material-purchasing`, migration 0436).
- **Law**: settled quantities are READ-ONLY truth for pricing composition (CR-HM-09); LABOR and MATERIAL never merge — in charges, entitlements, or settlement.
- **Tests**: material-execution-acquisition, material-purchasing suites.

## 10. J08 — Supervisor QC / Defect / Rework — COMPLETE

- **Commands**: evidence records/files/finalize, QC runs (`…/items`, `…/evidence`, `…/finish`), defects (`start-rectification`, `record-rectification`, `request-reinspection`, `pass-reinspection`) — `handyman-evidence-qc-api`.
- **Authority**: QC finish authority = `handyman.qc.manage` + exact Client/Building + ACTIVE assignment + actor ≠ Lead + ACTIVE supervisor reporting line + supervisor not an executing crew member (migration 0442); checklists are versioned and scope-bound (migration 0444).
- **Gate**: a current guarded QC PASS (versioned checklist complete, verified QC evidence, sessions completed, no unverified defects) is required before BAST prepare/issue/accept — enforced in service **and** in the database (migration 0445 trigger).
- **Tests**: evidence-qc-api, qc-supervisor-authority, qc-commands suites. (Note: several older suites' fixtures predate 0444/0445 and fail on `main` too — §16.)

## 11. J09 — BAST / Customer Acceptance — COMPLETE

- **Worker lane** (`handyman.bast.manage` + CURRENT Crew Lead): `POST /handyman/field/execution-scopes/:executionScopeId/bast/prepare`, `POST /handyman/field/bast/:bastId/issue|void`, `GET /handyman/field/execution-scopes/:executionScopeId/bast`.
- **Customer lane** (`manage` + exact Building): `POST /handyman/bast/:bastId/accept|reject|sign-off`, `GET /handyman/execution-scopes/:executionScopeId/bast`, `GET /handyman/bast/:bastId`. ACCEPT requires the current QC PASS and same-scope evidence; sign-off is signature-bound and replay-safe.
- **States**: `DRAFT → ISSUED → ACCEPTED | REJECTED | VOID`; ACCEPTED BAST is the sole warranty-start prerequisite (J11) and is preserved historically across VOID + re-PREPARE.
- **Tests**: `tests/handyman-bast-worker-api.test.ts` **13/13 PASS** (this CR), bast-acceptance/lifecycle/read-contract suites.

## 12. J10 — Invoice / Payment / Finance — COMPLETE (repaired this CR)

Pre-existing seams: ledger reads + payment record/confirm/reject (`handyman-customer-ledger-api`); invoices are issued through the generic tenant-invoices surface with `HANDYMAN_CHARGE` lines (migration 0432), and once a scope is invoiced, allocations only flow through charge lines linked to the FINALIZED single-scope invoice.

New seams this CR (`src/modules/handyman-finance-close-api/`, all `manage` + service-enforced exact-Building authority, strict body allow-lists):

| Command | Route | Body (references only) |
|---|---|---|
| Open transaction (one per AUTHORIZED scope) | `POST /handyman/execution-scopes/:executionScopeId/customer-transaction` | `idempotencyKey` |
| Compose charge line (amount server-derived from approved quotation snapshot) | `POST …/customer-charge-lines` | `quotationLineId, idempotencyKey` |
| Allocate confirmed payment (partial allowed) | `POST …/payment-allocations` | `paymentId, chargeLineId, amount, idempotencyKey` |
| Refund (forward-only) | `POST …/ledger-refunds` | `paymentId, amount, reason, idempotencyKey` |
| Reverse one allocation | `POST …/ledger-reversals/allocation` | `allocationId, reason, idempotencyKey` |
| Reverse one payment | `POST …/ledger-reversals/payment` | `paymentId, reason, idempotencyKey` |
| Adjust ledger (line- or transaction-scoped) | `POST …/ledger-adjustments` | `chargeLineId?, amount, reason, idempotencyKey` |

- **Repaired defect (priority 1/4)**: allocation caps were GROSS in the PART 04 service and in the migration-0413 DB guard, while PART 05 corrections, the refund bound and the PART 06 read all net reversed allocations ("a reversed allocation stops counting toward the applied amount"). Reversed funds could never be re-allocated — a one-way trap. The allocate command now nets reversals (service + repository) and **additive migration `0447_net_handyman_allocation_caps`** replaces only the two cap computations in the DB guard (up/down verified; facts remain append-only; the PART 04 gross summary is intentionally unchanged and still asserted by its frozen test).
- **Persistence/audit**: `handyman_customer_transactions`, `handyman_charge_lines` (+ composition basis), `handyman_customer_payments`, `handyman_payment_allocations`, `handyman_ledger_corrections` — all append-only with idempotency keys (migrations 0410–0414).
- **Tests**: new E2E suite tests 1–3 (§16); `handyman-ledger-corrections` 6/6, `handyman-customer-transaction` 6/6, scope-guard suites PASS.

## 13. J11 — Manager Close / Warranty — PARTIAL (warranty COMPLETE; manager-close aggregate MISSING)

New seams this CR:

| Command | Route | Gate |
|---|---|---|
| Start warranty (from ACCEPTED BAST only) | `POST /handyman/execution-scopes/:executionScopeId/service-warranty/start` | `manage` + exact Building |
| Expire warranty (`ACTIVE → EXPIRED`, append-only) | `POST /handyman/service-warranties/:warrantyId/expire` | `manage` + exact Building |
| Propose free rework (`REWORK_DRAFT`) | `POST /handyman/service-warranty-claims/:claimId/reworks` | auth-only; service enforces CURRENT Crew Lead |
| Start / Complete / Verify rework | `POST /handyman/service-warranty-reworks/:reworkId/start|complete|verify` | auth-only; CURRENT Crew Lead |

Existing customer-side seams (unchanged): warranty/claim/rework reads, claim open/submit/approve/reject/withdraw, **rework authorize (ACCEPT) stays customer-side**, chargeable additional-work accept/reject (`handyman-service-warranty-api`).

- **Ladder**: `REWORK_DRAFT → REWORK_AUTHORIZED → REWORK_IN_PROGRESS → REWORK_COMPLETE → REWORK_VERIFIED`; verify binds same-client/scope evidence (+ optional PASSED QC run). Warranty head: `ACTIVE → CLAIM_OPEN → CLAIM_APPROVED → REWORK_IN_PROGRESS → REWORK_COMPLETE`, `EXPIRED` terminal.
- **MISSING (authority decision, deliberately not invented)**: there is no overall request/scope **"manager close"** aggregate command. Terminals that exist: settlement `SETTLED` (J12), warranty `EXPIRED`/claim terminals, scope `AUTHORIZED`. A Manager persona close that aggregates finance + warranty requires a product decision on its prerequisites; the backend does not fabricate one.
- **Tests**: new E2E suite tests 4–5 — genuine guarded QC PASS → BAST accept (HTTP) → warranty start/expire (HTTP); claim approve (HTTP) → Lead propose/start/complete/verify (HTTP, Lead holds **no** RBAC permissions) → persisted event chain `PROPOSE, ACCEPT, START, COMPLETE, VERIFY`; non-Lead office actor is denied rework start (403).

## 14. J12 — BM Fee / Settlement / Reporting — PARTIAL (core COMPLETE; repaired this CR)

New seams this CR (`manage` unless noted):

| Area | Routes |
|---|---|
| Commercial agreement | `POST /handyman/commercial-agreements`, `POST /handyman/commercial-agreement-versions/:agreementVersionId/activate|supersede` |
| Pricing/BM-fee authoring (DRAFT versions only) | `POST …/labor-pricing-basis`, `…/material-pricing-basis`, `…/bm-fee-rule`, `…/bm-fee-term`, `…/bm-fee-beneficiary` |
| Published pricing reads (`read`) | `GET /handyman/pricing-contract?clientId&asOf`, `GET /handyman/bm-fee-configuration?clientId&asOf` |
| Entitlement derivation | `POST /handyman/execution-scopes/:executionScopeId/financial-entitlements/derive` |
| Settlement ladder | `POST …/settlement/prepare|include|reconcile|settle|correction|dispute` |
| Financial reads (`read`) | `GET …/financial-transaction`, `GET /handyman/financial-transactions?clientId&from&to&limit` |

- **Authority addition**: the commercial/pricing authoring services are client-scoped aggregates with no Building guard of their own, so the transport adds a `canAccessClient` guard (version → client resolution) before any mutation. Scope-bound finance commands delegate exact-Building authority to the owning services.
- **Money law**: entitlement derivation is atomic two-kind (PROVIDER + BM_FEE), requires an authoritative ledger and a DEFAULT BM-fee rule + term + beneficiary resolved at the ledger instant (REFERENCE/unconfigured ⇒ bounded refusal, never a silent default). Settlement records state only — **no fund movement**: each step re-reads the authoritative ledger under row lock; entitlement total must equal `chargedNet`; funding = min(applied, netReceived); open exceptions block include/settle; reconcile emits immutable `MATCHED`/`VARIANCE`; post-`SETTLED` corrections append (`REVERSED` only when a PART 02 `REVERSED` fact cites the same ledger correction, else `ADJUSTED`).
- **MISSING (deliberately not invented)**: settlement dispute **clearing/adjudication** — `holdDispute` records the hold; no adjudication vocabulary exists upstream. Provider payout execution (real disbursement) is out of backend scope by design.
- **Reporting**: financial reads above + `GET /handyman/provider-performance`, SLA status (`handyman-sla-status-api`), status-visibility projections.
- **Tests**: new E2E suite test 1 — commercial authoring → pricing reads (`authoritativeForEntitlement: true`) → ledger → derive (provider `97.50` / BM fee `2.50` on a `100.00` LABOR charge at 2.5%) → `PAYABLE → INCLUDED_IN_SETTLEMENT → MATCHED → SETTLED` → post-settlement refund + correction → `VARIANCE`, with persisted settlement-event and entitlement-fact assertions.

---

## 15. Repairs implemented in this CR

1. **New transport module** `src/modules/handyman-finance-close-api/` (validation/controller/routes/index), registered once in `src/routes/index.ts`. Thin transport only — every command delegates to the owning CR-HM-12/13/14/15 service; strict per-endpoint body allow-lists reject smuggled authority fields with 400.
2. **Net allocation caps** — `handyman-payment-allocation.service.ts` + repository (net of ALLOCATION REVERSAL corrections for caps, replay and post-insert derived figures).
3. **Additive migration `0447_net_handyman_allocation_caps`** — DB guard caps net reversed allocations; down restores the exact 0413 body (verified up/down against a disposable DB). No historical row rewritten.
4. **Persona-handoff integration tests** `tests/handyman-e2e-finance-close-api.test.ts` (disposable embedded PostgreSQL, real HTTP, persisted-state assertions).
5. **This matrix.**

No merged capability was duplicated; Dispatch, Commercial Inbox, QC and Worker BAST surfaces are untouched.

## 16. Test evidence

**New suite** (`NODE_ENV=test npx tsx --test --test-concurrency=1 tests/handyman-e2e-finance-close-api.test.ts`, embedded PostgreSQL 18, port 55541):

| Result | Count |
|---|---|
| PASS | **5** at CR completion (J12→J10→J12 full journey; J10 corrections; authority boundaries; J11 warranty start/expire; J11 rework ladder); a 6th finance-integrity test was added by the final gate — see §18.4 (6 PASS / 0 FAIL / 0 SKIPPED) |
| FAIL | 0 |
| SKIPPED | 0 |

**Typecheck**: `npm run typecheck` PASS.

**Regression (this branch vs clean `main` baseline worktree, same disposable DB)** — identical results unless noted:

| Suite | Branch | Baseline (`main`) |
|---|---|---|
| `handyman-bast-worker-api` | 13 PASS / 0 FAIL | (not re-run; untouched surface) |
| `handyman-ledger-corrections` | 6/6 PASS | — |
| `handyman-customer-transaction` | 6/6 PASS | — |
| `handyman-ledger-correction-scope-guard` / `handyman-payment-allocation-scope-guard` | PASS | — |
| `handyman-commercial-agreement` / `handyman-labor-pricing` | 6/6 PASS | — |
| `handyman-payment-allocation` | 5 PASS / 1 FAIL | 5 PASS / 1 FAIL (same) |
| `handyman-ledger-read-contract` | 5 PASS / 1 FAIL | 5 PASS / 1 FAIL (same) |
| `handyman-customer-care-ledger` | 4 PASS / 1 FAIL | 4 PASS / 1 FAIL (same) |
| `handyman-entitlement-part02-derivation` / `handyman-financial-read-part04` / `handyman-settlement-part03` | 0/3 | 0/3 (same) |
| `handyman-service-warranty-part01` / `handyman-service-warranty-rework-part03` | 4 PASS / 6 FAIL | identical |
| `handyman-customer-care-qc-bast` | 0/5 | 0/5 (same) |
| `handyman-customer-care-transport-certification` | 0/5 | 0/5 (same) |
| `handyman-lifecycle-api` | 9 PASS / 1 FAIL | 9 PASS / 1 FAIL (same) |
| `handyman-material-pricing` / `handyman-bm-fee-prerequisite-configuration` | 5 PASS / 1 FAIL | identical |
| `migrate.test` | 1 FAIL | 1 FAIL (same) |
| `handyman-inspector-authority` | 30 PASS / 2 FAIL (mocked TEMP harness lacks 0434 table; not re-run on baseline — code untouched by this CR) | — |
| `handyman-scope-assignments-api` | 0 PASS / 10 FAIL (0439 fixture staleness, `HANDYMAN_WORKFORCE_BINDING_REQUIRED`) | same root cause proven for sibling suites |

**Pre-existing failures (NOT caused by this CR; byte-identical on clean `main`)** — recorded so they are not mistaken for regressions:
- Stale fixtures after migration 0439 workforce-building eligibility: crew-assignment fixtures in settlement/entitlement/financial-read/material-pricing suites fail with `HANDYMAN_WORKFORCE_BINDING_REQUIRED` (the newer suites add `assignBuildingToWorkforce` first; the new E2E suite does).
- Stale BAST fixtures after the 0445 guarded-QC-pass gate: warranty part01 / rework part03 / customer-care-qc-bast arrange BASTs without a current guarded QC PASS (`HANDYMAN_BAST_QC_NOT_READY` class failures). The production gate is correct and is **not** weakened; the new E2E suite builds a genuine QC PASS instead.
- Stale assertion debt: lifecycle-api exact-OpenAPI-surface test; payment-allocation firewall sweep vs the later invoice gate; ledger-read FK firewall vs migration 0432; customer-care-ledger `availableActions` payload drift; bm-fee migration-directory listing.

## 17. Remaining gaps & exact consumer-repository handoffs

**Requires a product/authority decision (backend deliberately does not invent):**
1. Tenant-request `CANCELLED` status + cancel command (J01) — vocabulary, who may cancel at which states, and downstream effects on appointments/quotations.
2. Overall "Manager close" aggregate (J11) — its prerequisites across settlement/warranty/QC.
3. Settlement dispute clearing/adjudication (J12).

**Consumer availability — `BLOCKED OTHER REPO`:** every backend seam below is live and tested in this repository, but end-user availability is `BLOCKED OTHER REPO` until the consumer repositories integrate them (this CR is backend-only by instruction; no frontend/mobile coding was started):

| Consumer repo | Blocked capability | Unblocked by |
|---|---|---|
| Customer Care web / BM Super App | J10 ledger open/charge/allocation/corrections screens; J12 commercial authoring, settlement ladder, financial reporting views | Integrating the §12/§14 endpoints (references + `idempotencyKey` only) |
| BM Super App (tenant side) | J12 pricing/BM-fee read views | `GET /handyman/pricing-contract`, `GET /handyman/bm-fee-configuration` |
| Worker mobile app | J11 field rework ladder (propose/start/complete/verify) with the Crew Lead's own session | Integrating the §13 auth-only endpoints (no RBAC permission needed) |

**Consumer repositories (BM Super App / Customer Care web / worker mobile) must:**
1. Call the new finance-close endpoints (§12–§14) with references + single-use `idempotencyKey` only; never send amounts for charge composition, states, actor or client/building authority fields (unknown fields are rejected 400).
2. Use the auth-only field rework ladder from the worker app with the Crew Lead's own session; rework **authorize** remains the customer-side command.
3. Treat `GET /handyman/financial-transactions` and pricing reads as read-only reporting inputs (`isFinalCharge: false` facts), not as payment instructions; settlement records state, never fund movement.

**Contract documentation**: the endpoints above are authoritative in this matrix and in the router (`src/modules/handyman-finance-close-api/handyman-finance-close-api.routes.ts`). Since the final gate (§18), all 32 routes are also documented in `docs/api/openapi.yaml` (request/response, permission, scope and error contract per route).

**Out of scope by instruction**: no Railway deploy, no production migration, no reset/force-push. Migration 0447 is additive and ships with the code for the normal migration runner.

## 18. Final contract & authority gate (PR #29)

### 18.1 Endpoint inventory — 32 routes, `src/modules/handyman-finance-close-api/`

All successes are HTTP 200 with the standard `{ success, data }` envelope. The actor is always `req.auth`; strict body allow-lists reject unknown/authority fields with 400. `manage` = `tenant_company.manage`, `read` = `tenant_company.read`. Every mutating route requires `idempotencyKey`: replay with the same payload returns the original result; rebinding the key to a different payload is 409. Money is canonical decimal strings.

| # | Route | Permission | Scope authority | Financial / state effect |
|---|---|---|---|---|
| 1 | `POST /handyman/commercial-agreements` | manage | Client (`canAccessClient`) | Prepares agreement (no amounts) |
| 2 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/activate` | manage | Client via version | Activates version from `effectiveFrom` |
| 3 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/supersede` | manage | Client via version | Supersedes with prepared replacement |
| 4 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/labor-pricing-basis` | manage | Client via version | Labor pricing basis (mode/crew/unitAmount) |
| 5 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/material-pricing-basis` | manage | Client via version | Material pricing basis |
| 6 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-rule` | manage | Client via version | BM fee rule (basis/mode) |
| 7 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-term` | manage | Client via version | BM fee term (`ratePercent`) |
| 8 | `POST /handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-beneficiary` | manage | Client via version | BM fee beneficiary |
| 9 | `GET /handyman/pricing-contract?clientId&asOf` | read | Client | Read-only |
| 10 | `GET /handyman/bm-fee-configuration?clientId&asOf` | read | Client | Read-only |
| 11 | `POST /handyman/execution-scopes/{executionScopeId}/customer-transaction` | manage | Exact Building via scope | Opens transaction once (idempotent) |
| 12 | `POST /handyman/execution-scopes/{executionScopeId}/customer-charge-lines` | manage | Exact Building via scope | Charge composed from confirmed quotation line; amount server-derived |
| 13 | `POST /handyman/execution-scopes/{executionScopeId}/payment-allocations` | manage | Exact Building via scope | Allocates ≤ NET unallocated payment & charge capacity |
| 14 | `POST /handyman/execution-scopes/{executionScopeId}/ledger-refunds` | manage | Exact Building via scope | Refund ≤ net received-and-applied; above → 409, nothing recorded |
| 15 | `POST /handyman/execution-scopes/{executionScopeId}/ledger-reversals/allocation` | manage | Exact Building via scope | Reverses one allocation exactly; restores capacity |
| 16 | `POST /handyman/execution-scopes/{executionScopeId}/ledger-reversals/payment` | manage | Exact Building via scope | Reverses payment; requires all allocations reversed first |
| 17 | `POST /handyman/execution-scopes/{executionScopeId}/ledger-adjustments` | manage | Exact Building via scope | Signed adjustment (optional charge line) |
| 18 | `POST /handyman/execution-scopes/{executionScopeId}/financial-entitlements/derive` | manage | Exact Building via scope | Derives provider payable + BM fee server-side |
| 19–23 | `POST .../settlement/prepare|include|reconcile|settle|correction` | manage | Exact Building via scope | Settlement ladder; records state only, never moves funds (`correction` takes `ledgerCorrectionId`) |
| 24 | `POST /handyman/execution-scopes/{executionScopeId}/settlement/dispute` | manage | Exact Building via scope | Opens dispute HOLD only — adjudication NOT implemented (product decision pending) |
| 25 | `GET /handyman/execution-scopes/{executionScopeId}/financial-transaction` | read | Exact Building via scope | Read-only transaction view |
| 26 | `GET /handyman/financial-transactions?clientId&from&to&limit` | read | Client (read service) | Read-only reporting |
| 27 | `POST /handyman/execution-scopes/{executionScopeId}/service-warranty/start` | manage | Exact Building via scope | Starts warranty; window server-derived |
| 28 | `POST /handyman/service-warranties/{warrantyId}/expire` | manage | Building via the warranty's own scope (404 before any state change) | Expires warranty |
| 29 | `POST /handyman/service-warranty-claims/{claimId}/reworks` | authenticated only | Service requires CURRENT Crew Lead of the claim's Building assignment | Proposes free rework |
| 30 | `POST /handyman/service-warranty-reworks/{reworkId}/start` | authenticated only | Same Crew-Lead rule | Starts rework |
| 31 | `POST /handyman/service-warranty-reworks/{reworkId}/complete` | authenticated only | Same Crew-Lead rule | Completes rework |
| 32 | `POST /handyman/service-warranty-reworks/{reworkId}/verify` | authenticated only | Same Crew-Lead rule + QC-passed evidence | Verifies rework; failure keeps claim actionable |

Boundary evidence: no route exposes Finance/Manager authority through Worker or Customer Care permissions — rework routes are auth-only with the Crew-Lead rule inside the service (never an RBAC shortcut), and every finance route denies actors lacking `tenant_company.manage` (403) or Building access (404-style), proven in E2E test 3 including a smuggled-authority-field 400.

### 18.2 Migration 0447 review

`0447_net_handyman_allocation_caps.ts` is additive and function-replacement only: it redefines the 0413 allocation-cap guard to NET semantics (gross allocations minus ALLOCATION-kind REVERSAL corrections). Its `down` restores the exact 0413 body (verified up/down during the CR). No table/column changes, no historical row rewritten, and no other schema change exists in PR #29 (diff vs `main`: 11 files, transport + netting + this migration + index registration + tests + docs only).

### 18.3 Gate fixes and integrity evidence

One verified defect was found and fixed in this gate: an over-refund escaped the correction service as a raw database-guard error (HTTP 500). Known migration-0414/0413 guard messages and unique violations are now mapped to bounded 409 `HANDYMAN_CUSTOMER_LEDGER_CORRECTION_CONFLICT` / allocation-conflict responses at the service layer (raw guard text preserved where the frozen PART 05 contract asserts it). New E2E test 6 proves, over real HTTP with persisted-state assertions: refund above net applied is rejected and records nothing; two concurrent allocations racing for the last capacity produce exactly one success and allocations totalling exactly the charge; same-key replay returns the original allocation; key rebinding is 409; allocation reversal restores allocatable capacity (net `paymentUnallocated` returns to `0.00` after re-allocation). Gross historical reporting (`summarizeHandymanPaymentAllocations`) is unchanged by design; command caps are net at both service and DB-guard layers.

### 18.4 Gate validation (targeted only)

| Check | Result |
|---|---|
| `tests/handyman-e2e-finance-close-api.test.ts` (6 tests) | 6 PASS / 0 FAIL / 0 SKIPPED |
| `tests/handyman-ledger-corrections.test.ts` | 6 PASS / 0 FAIL / 0 SKIPPED |
| `tests/handyman-payment-allocation.test.ts` | 5 PASS / 1 FAIL — identical to baseline (stale firewall token; not a regression) |
| `tests/audit-part05-openapi.test.ts` | 4 PASS / 0 FAIL |
| `tests/cr-be-fin-rpt-01-part05-openapi.test.ts` standalone | 14 PASS / 1 FAIL — only the stale `0334 must not exist` pin (pre-existing); router-alignment and `$ref` subtests PASS with the new entries |
| `tests/mobile-openapi-completeness.test.ts` + fin-rpt combined | 17 PASS / 3 FAIL — byte-identical on clean PR HEAD (pre-existing) |
| `npm run typecheck` | PASS |
| `docs/api/openapi.yaml` | parses (OpenAPI 3.0.3), 32 new operations, no duplicate operationIds, all `$ref`s resolve |

Full-suite re-runs were intentionally not repeated; the §16 baseline comparison stands. The Inspector (0434 TEMP-harness table) and Scope-Assignment (0439 fixture) debts in §16 remain recorded as harness/fixture debt — production workforce Building-assignment and QC gates are unchanged.

### 18.5 Still PARTIAL — authority decisions required (not invented)

Tenant cancellation policy (J01), manual Manager CLOSE aggregate (J11), and settlement dispute adjudication (J12) remain PARTIAL exactly as in §17; route 24 records the dispute hold only.

## 19. CR-HM-FIN-AUTH-01 — dedicated Commercial / Finance / Settlement authority

The §18 gate's open question — `tenant_company.manage` is generic, so Finance persona isolation did not exist (proven: a manage-only actor allocated and refunded with HTTP 200) — was decided as **Option B: explicit domain permissions**. Full inventory, permission matrix, provisioning runbook and migration notes: `docs/handyman/CR-HM-FIN-AUTH-01_FINANCE_AUTHORITY.md`.

- New permissions (migration `0448_handyman_finance_authority_permissions`, catalogue + foundation seed, **unassigned by default — not even PLATFORM_ADMIN inherits**): `handyman.commercial.manage`, `handyman.finance.read`, `handyman.finance.manage`, `handyman.settlement.manage`.
- The §18.1 permission column is superseded for the 32 routes: commercial authoring + warranty start/expire → `handyman.commercial.manage`; ledger open/charge/allocation/refund/reversals/adjustment + entitlement derivation → `handyman.finance.manage`; settlement ladder → `handyman.settlement.manage`; the 4 finance-close reads → `handyman.finance.read`; the 4 rework routes stay auth-only Crew-Lead.
- Existing merged surface secured coherently: payment **verification** (confirm/reject on the customer-ledger API) now requires `handyman.finance.manage`; payment **reporting** (record) and customer ledger reads keep `tenant_company.manage` / `.read` so legitimate Customer/Tenant reporting is unbroken.
- Domain separation is non-implicative: settlement ⊄ refund, commercial ⊄ allocation, finance ⊄ settlement; scope (Client/exact-Building) still binds every grant; rejected mutations persist nothing.
- Evidence: `tests/handyman-finance-authority.test.ts` (personas A–E, reporting-vs-verification split, spoof 400, cross-scope denial, audit actors, exact persisted totals); E2E lifecycle suite stays 6/6; affected merged suites are at or better than their verified baselines (customer-care-ledger verifier fixtures now carry the Finance grant — tests 1 & 5 failures there are the pre-existing ones from §16).
- J11 Manager CLOSE and J12 dispute adjudication remain PARTIAL by separate product decision (§18.5 unchanged).
