# Handyman Backend — API Handoff: Customer Care (Frontend / Customer Care web)

**Repository**: `budiirmawan/Handyman-Backend` (backend ONLY).  
**Branch**: `arena/c965a40c-handyman-backend` · **Date**: 2026-10-21 · **CR**: CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01  
**Companion**: `docs/api/HANDYMAN_BACKEND_API_HANDOFF.md` (shared transport contract, permissions, conventions — read first), `docs/handyman/HANDYMAN_E2E_PERSONA_CAPABILITY_MATRIX.md` (§20), `docs/api/openapi.yaml` (1411 paths, 174 `/handyman`).  
**Claim boundary**: Backend-repository evidence only. **No cross-repository E2E PASS is claimed;** Frontend availability waits on the Handyman-Frontend repo integrating these contracts.

## Audience

Handyman-Frontend (Customer Care web). Customer Care actors operate via the care workspace registry (migrations 0425–0430) within a granted property context; every call is scoped to an exact Building assignment (`user_building_assignments`). There is no same-Client shortcut.

## Transport contract (all endpoints)

Base `…/api/v1`; `Authorization: Bearer <sessionToken>` from `POST /api/v1/auth/login` (`{ email, password }`).  
Envelopes: success `{ success: true, data, meta }`; failure `{ success: false, error: { code, message, details? } }`.  
Statuses: 401 unauthenticated · 403 RBAC/building · 404 unknown or out-of-scope (never filtered lists) · 409 state/idempotency conflict · 400 validation (`error.details[]` field list).  
Every mutating command takes `idempotencyKey` (≤200 chars): same key + same payload → `replayed: true`; same key + different payload → 409.  
All amounts are server-derived; bodies carry references + `idempotencyKey` only. Money serializes as canonical decimal strings.

## Customer Care endpoint map (subset relevant to this lane)

| Journey | Endpoint | Method | Gate | Notes |
|---|---|---|---|---|
| J01 intake | `POST /handyman/requests[/care]` | POST | care actor session | Request `CANCELLED` does **not** exist (product decision pending) |
| J01 intake | `POST …/triage` | POST | care actor session | channel attribution recorded, never re-derived client-side |
| J01 reads | `GET /handyman/operations/queue` | GET | `tenant_company.read` + building | care workspace queue |
| J02 visits | `POST /handyman/visit-appointments/:id/inspector\|/reassign\|/revoke` | POST | care actor session | scoped appointment proposals only (R1C) |
| J02 consent | `POST /handyman/integrations/tenant-slot-choices` · `POST /handyman/requests/:id/visits/:appointmentId/confirm` | POST | tenant session | appointment not authoritative until tenant confirms |
| J09 BAST | `GET /handyman/bast/:id` | GET | `tenant_company.read` + `canAccessClient` | never exposes `storageKey` |
| J09 BAST | `POST /handyman/bast/:id/accept` | POST | `tenant_company.manage` + `canAccessClient` + idempotency | carries `signatureDigest` + same-scope `evidenceRecordId`; DRAFT → `HANDYMAN_BAST_ILLEGAL_TRANSITION` 409 |
| J09 BAST | `POST /handyman/bast/:id/reject\|sign-off` | POST | same as accept | VOID then re-PREPARE is legal; guard is on the CURRENT guarded QC PASS |
| J10–J12 close reads | `GET /handyman/…/invoice-reconciliation`, `GET …/final-close/readiness` | GET | `handyman.finance.read` | readiness exposes `eligibleForFinalClose`, `gates{10}`, `blockers[{code,message}]` — 20 frozen codes |

Firewall (verified by suite): Customer Care is rejected 403 on all CR-HM-10 POST commands (evidence create/file/finalize, QC open/items/finish, defect ladder) — it is a **read-only + governed sign-off** lane, never a Crew-Lead/Supervisor field lane.

## Read-model conventions

- Payment payloads carry **transport-projected** `availableActions` (status-derived). Render from it, but every write is re-authorized server-side; a stale button hitting 409/403 is expected, not a client bug.
- State machines are authoritative in this repo only. Hardcode nothing; advance by command + read.
- Settlement moves **no funds** — it records state; disbursement is out of backend scope.

## Schema requirements

IDs to keep and echo: `handymanRequestId`, `executionScopeId`, `bastId`, `evidenceRecordId`, `qcRunId`, plus every `idempotencyKey` issued. Consumers never own tables, migrations, or direct DB access. Contract source of truth: `docs/api/openapi.yaml`. Integration questions cite path + `error.code`.
