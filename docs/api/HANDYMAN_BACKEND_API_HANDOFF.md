# Handyman Platform — Backend API Handoff (complete-capability baseline)

- **Audience**: `Handyman-Frontend` (BM Super App / Customer Care web), `Handyman-Operations`, `Handyman-Mobile` (worker app). This repository is the ONLY authority: persistence, authorization, workflow, state machines, money and `availableActions`. Consumer repositories implement screens/calls only — never business authority.
- **Generated**: 2026-10-20, CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01. Companion governance: `docs/handyman/HANDYMAN_E2E_PERSONA_CAPABILITY_MATRIX.md` (journey semantics, §12–§14 + §20) and `docs/handyman/HANDYMAN_E2E_LIFECYCLE_VERIFICATION_REPORT.md` (evidence). **Scope of claims: verified Backend-only; nothing here asserts consumer-repo E2E status.**

## 1. Transport contract (every endpoint)

- Base: `…/api/v1`; auth `Authorization: Bearer <sessionToken>` from `POST /api/v1/auth/login` (`{ email, password }`). 401 unauthenticated; 403 RBAC/building; 404 unknown-or-out-of-scope before any state change; 409 state/idempotency conflict; 400 validation with `error.details[]` field list.
- Success envelope `{ "success": true, "data": … , "meta": … }`; failure `{ "success": false, "error": { "code", "message", "details?" } }`.
- **Idempotency**: every mutating Handyman command takes `idempotencyKey` (≤200 chars). Same key + same payload → original result with `replayed: true`; same key + different payload → 409. Keys are single-use facts, never retry tokens with mutated bodies.
- **Money law**: all amounts are server-derived; consumers send **references only** (IDs + `idempotencyKey`; plus the explicitly listed amounts for allocation/refund/adjustment, which the server bounds). Money serializes as canonical decimal strings. Amounts derived from the APPROVED quotation version (immutable); unknown/extra body fields are rejected 400 (strict allow-lists).
- Optimistic concurrency: reassign-style commands require `expectedVersion` (current row version) and `reason`.

## 2. Permission inventory (grant codes; RBAC provisioning lives in this repo)

| Capability group | Permission |
|---|---|
| Staff reads (queues, ledger reads, pricing reads, reporting) | `tenant_company.read` (+ building assignment for scope-bound reads) / `handyman.finance.read` for finance-close reads |
| Customer-side & operations commands (BAST accept/reject, claim approve, dispatch, triage, assignments) | `tenant_company.manage` |
| Commercial authoring + warranty start/expire | `handyman.commercial.manage` |
| Ledger open/charge/allocate/refund/reversal/adjustment, entitlement derive | `handyman.finance.manage` |
| Settlement ladder + dispute hold | `handyman.settlement.manage` |
| Manager FINAL CLOSE | `finding.close` (+ `handyman.finance.read`) |
| Supervisor QC commands | `handyman.qc.manage` (plus ACTIVE supervisor reporting line, not an executing crew member) |
| QC checklist publish/bind | `handyman.qc.configure` |
| Worker field lane (work sessions, field evidence, worker BAST prepare/issue/void, rework ladder, arrival/check-in) | **authentication only** — the service enforces CURRENT Crew Lead / assigned worker; never add RBAC shortcuts for the worker app |

Data scope everywhere: exact Building assignment (`user_building_assignments`); no same-Client shortcut. SaaS isolation: every Handyman fact is Client-scoped; cross-tenant reads are 404-shaped, never filtered lists.

## 3. Endpoint map by persona (normative detail: `docs/api/openapi.yaml` — 1432 paths, 1918 operations, 179 `/handyman` paths; freeze candidate CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 v1.0, see `docs/contract-freeze/`)

**BM Super App / Customer Care web (staff & customer lanes)**
- J01 requests: `POST /handyman/requests[/care]`, `POST …/triage`, `GET /handyman/operations/queue`, care workspace (`handyman-care-workspace`). Request `CANCELLED` **exists** (migration `0459`, PR #48): `POST /handyman/requests/{handymanRequestId}/cancel`, `GET …/cancellation`, Care `POST /handyman/care/buildings/{buildingId}/requests/{requestId}/cancel` — exact payloads/errors in `docs/api/CR-HM-18_FRONTEND_HANDOFF.md` §2. Settlement dispute adjudication likewise exists (migration `0460`): `POST /handyman/execution-scopes/{executionScopeId}/settlement/dispute/resolution` (`RELEASED|UPHELD`).
- J02: visit proposals + `POST /handyman/visit-appointments/:id/inspector[/reassign|/revoke]`, tenant slot consent (`POST /handyman/integrations/tenant-slot-choices`, `POST /handyman/requests/:id/visits/:appointmentId/confirm` — the appointment is not authoritative until the tenant confirms), `POST …/inspection`, `POST …/diagnosis`.
- J03: `POST …/quotation`, `POST /handyman/quotations/:id/versions` (accepts **DP terms** `dpRequired/dpPercentage/dpAmount/dpTermsNotes` while DRAFT), issue, `POST /handyman/quotations/:id/approve|reject`.
- J04: `POST /handyman/execution-scopes/:id/assignment[/reassign]` (body: `providerContextId`, `crewId`, `expectedVersion`, `reason`), dispatch readiness/release/cancel, arrival verification.
- J08: evidence/QC (`/handyman/execution-scopes/:id/evidence*`, `/handyman/qc-runs/:id/items|evidence|finish`, defect ladder).
- J09: `POST /handyman/bast/:id/accept|reject|sign-off` (accept carries `signatureDigest` + same-scope `evidenceRecordId`); VOID then re-PREPARE is legal — the guard is on the CURRENT guarded QC PASS (a BAST can never be prepared before it).
- J10–J12 + final close: the 32 `handyman-finance-close-api` routes (matrix §18.1 table) plus `GET …/invoice-reconciliation`, `GET …/final-close/readiness`, `POST …/final-close`; payment recording on `handyman-customer-ledger-api` accepts `obligationStage: DP | TERMIN | PELUNASAN`.

**Worker mobile app (auth-only field lane)**
- `GET /handyman/field/me`, worker profile (`/handyman/field/workers/:id/profile`).
- Field evidence: `POST /handyman/field/evidence/upload` (bytes; server verifies sha256/size), list/confirm/download per scope/request (`/handyman/field/evidence/:id/bytes|content|confirm`).
- Work sessions: `POST /handyman/work-sessions/:id/check-in|start-work|pause|material-run|resume|complete|check-out`, `GET …/active`, `GET /handyman/work-sessions/:id/time-projection`.
- Materials & variations lanes: `handyman-material-execution` (`estimate→approve→issue→purchase→use→return→settle`) and `handyman-scope-variations` (propose/decide ADD/REDUCE) routers.
- Worker BAST: `POST /handyman/field/execution-scopes/:id/bast/prepare`, `POST /handyman/field/bast/:id/issue|void`, `GET /handyman/field/execution-scopes/:id/bast`.
- Warranty rework ladder: `POST /handyman/service-warranty-claims/:claimId/reworks` then `…/reworks/:reworkId/start|complete|verify` (verify binds same-scope evidence + a PASSED QC run; authorize stays customer-side).

**BM Super App handoff (intake provenance)**
- `POST /handoff/assertions`, `POST /handoff/channel-attributions` — attribution is recorded, never re-derived client-side. SSO: the platform session (`sessionToken`) is the only credential Handyman trusts; no per-app tokens.

## 4. Read-model conventions consumers must respect

- `GET …/customer-ledger*` payment payloads carry **transport-projected** `availableActions` (from status alone) — render from it, but re-attempt writes are always re-authorized server-side; a stale button hitting 409/403 is the normal outcome, never a client bug to work around.
- State machines are authoritative in this repo only (request/triage, dispatch, work session, QC run, BAST `DRAFT→ISSUED→ACCEPTED|REJECTED|VOID`, warranty `ACTIVE→CLAIM_OPEN→CLAIM_APPROVED→REWORK_*→…/EXPIRED`, settlement `PREPARED→INCLUDED→RECONCILED(MATCHED|VARIANCE)→SETTLED`, scope `AUTHORIZED→CLOSED`). Hardcode nothing; advance by command + read.
- FINAL CLOSE readiness (`eligibleForFinalClose`, `gates{10}`, `blockers[{code,message}]` — 20 frozen codes) is the only pre-close check; attempt the command and render blockers, do not reimplement the gates.
- Settlement moves **no funds** — it records state; disbursement is out of backend scope.

## 5. Schema requirements for consumers

- Consumers never own tables, migrations, or direct DB access; all Handyman persistence is this repository (459 registered migrations, head `0460_handyman_settlement_dispute_adjudication`, `0449` intentionally unclaimed/reserved; production execution deferred to the platform release — pending order in `docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_SCHEMA_FREEZE_CANDIDATE.md`).
- IDs to keep and echo: `handymanRequestId`, `executionScopeId`, `bastId`, `transactionId`, `chargeLineId`, `paymentId`, `allocationId`, `warrantyId`, `claimId`, `reworkId`, `qcRunId`, `evidenceRecordId`, `settlementId`, plus every `idempotencyKey` issued. FK-only references; no derived state stored client-side beyond caches.
- Contract source of truth: `docs/api/openapi.yaml` (parses, all operationIds unique). Any new seam appears here first; matrix §20 records capability verdicts. Integration questions should cite path + `error.code`.
