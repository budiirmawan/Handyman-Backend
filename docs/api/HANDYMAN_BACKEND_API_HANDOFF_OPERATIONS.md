# Handyman Backend — API Handoff: Operations (Handyman-Operations)

**Repository**: `budiirmawan/Handyman-Backend` (backend ONLY).  
**Branch**: `arena/c965a40c-handyman-backend` · **Date**: 2026-10-21 · **CR**: CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01  
**Companion**: `docs/api/HANDYMAN_BACKEND_API_HANDOFF.md` (shared transport contract, permissions, conventions — read first), `docs/handyman/HANDYMAN_E2E_PERSONA_CAPABILITY_MATRIX.md` (§20), `docs/handyman/CR-HM-CARE-INTERNAL-NOTES-01_PART-01.md` (`GET/POST /handyman/requests/{handymanRequestId}/internal-notes`), `docs/api/openapi.yaml` (1432 paths, 1918 operations, 179 `/handyman` paths; freeze candidate CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 v1.0).
**Claim boundary**: Backend-repository evidence only. **No cross-repository E2E PASS is claimed;** Operations availability waits on the Handyman-Operations repo integrating these contracts.

## Audience

Handyman-Operations. Operations personas (Operations Manager, Dispatcher, Finance, BM) act with `tenant_company.manage` (or finance/settlement/commercial permissions) bound to an exact Building assignment. The backend is the sole authority for persistence, authorization, workflow, state machines, money and `availableActions`.

## Transport contract (all endpoints)

Base `…/api/v1`; `Authorization: Bearer <sessionToken>` from `POST /api/v1/auth/login` (`{ email, password }`).  
Envelopes: success `{ success: true, data, meta }`; failure `{ success: false, error: { code, message, details? } }`.  
Statuses: 401 · 403 RBAC/building · 404 unknown or out-of-scope · 409 state/idempotency conflict · 400 validation.  
Every mutating command takes `idempotencyKey`; same key + different payload → 409. Amounts are server-derived; bodies carry references + `idempotencyKey` only.

## Operations endpoint map by journey

| Journey | Endpoint | Method | Gate | Notes |
|---|---|---|---|---|
| J02 | `POST /handyman/visit-appointments` (+ inspector assign/reassign/revoke) | POST | `tenant_company.manage` + building | inspector visit assignment surface (P0-A) |
| J02 | `POST …/inspection`, `POST …/diagnosis` | POST | ops session | records bound to scope/request |
| J03 | `POST …/quotation`, `POST /handyman/quotations/:id/versions` | POST | `tenant_company.manage` | DP terms `dpRequired/dpPercentage/dpAmount/dpTermsNotes` accepted while DRAFT; fixed at version |
| J03 | `POST /handyman/quotations/:id/approve\|reject` | POST | tenant session | decision bound to exact presented version |
| J04 | `POST /handyman/execution-scopes/:id/assignment\|/reassign` | POST | `manage` + building | body: `providerContextId`, `crewId`, `expectedVersion`, `reason`; reassign supersedes only with a DIFFERENT registered crew |
| J04 | dispatch readiness / release / cancel; arrival verification | POST/GET | `manage` + building | `WorkPermitReadinessRouter`, `SecurityVisitorBindingRouter` |
| J08 | QC: `POST /handyman/execution-scopes/:id/qc-runs`, `…/qc-runs/:id/items\|evidence\|finish` | POST | `handyman.qc.manage` + ACTIVE supervisor-of-Lead reporting line + not a crew member | guarded by versioned pinned checklist (`handyman.qc.configure` to publish/bind) |
| J08 | defects: `…/execution-scopes/:id/defects`, `…/defects/:id/start-rectification\|record-rectification\|request-reinspection\|pass-reinspection` | POST | Supervisor / PIC per ladder | `expectedVersion`+`reason` required; replay 409 on mismatched metadata |
| J09 | BAST: `POST /handyman/bast/:id/prepare\|issue` | POST | crew Lead / worker lane (auth-only) | guarded: latest versioned Supervisor QC PASS + completed Work Sessions + resolved defects + verified QC bytes |
| J10 | ledger open/charge; payment record/confirm (`obligationStage: DP\|TERMIN\|PELUNASAN`) | POST | `handyman.finance.manage` | amounts server-derived; allocation bounded by NET caps (0447) |
| J10 | allocation / corrections / refund / reversal | POST | `handyman.finance.manage` | correction/refund bounds enforced |
| J11 | warranty start/expire; claim approve/reject/withdraw; rework authorize | POST | `manage` / `handyman.commercial.manage` | start from ACCEPTED BAST only |
| J11 | Manager FINAL CLOSE: `GET …/final-close/readiness`, `POST …/final-close` | GET/POST | `finding.close` + `handyman.finance.read` | 20 frozen blocker codes; scope → CLOSED, append-only close event |
| J12 | commercial agreement + pricing/BM-fee authoring; entitlement derive; settlement prepare/include/reconcile/reconcile/settle | POST | `handyman.commercial.manage` / `handyman.settlement.manage` | settlement records state only — no fund movement |
| Cross | `GET /handoff/assertions`, `POST /handoff/channel-attributions` | — | session auth | attribution provenance for BM Super App |

## Conventions Operations must respect

- FINAL CLOSE readiness (`eligibleForFinalClose`, `gates{10}`, `blockers` — 20 codes) is the only pre-close check; attempt the command and render blockers, do not reimplement the gates.
- `availableActions` on payment/ledger payloads is transport-projected; re-attempt writes always re-authorized server-side.
- Settlement: `PREPARED→INCLUDED→RECONCILED(MATCHED\|VARIANCE)→SETTLED`; dispute hold recorded, adjudication is a product gap (not implemented).
- Disbursement/fund movement is out of backend scope.

Contract source of truth: `docs/api/openapi.yaml` (unique operationIds). Integration questions cite path + `error.code`.
