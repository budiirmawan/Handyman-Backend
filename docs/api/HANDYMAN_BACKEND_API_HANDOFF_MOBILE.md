# Handyman Backend — API Handoff: Mobile (Handyman-Mobile worker app)

**Repository**: `budiirmawan/Handyman-Backend` (backend ONLY).  
**Branch**: `arena/c965a40c-handyman-backend` · **Date**: 2026-10-21 · **CR**: CR-HM-BACKEND-FULL-CAPABILITY-E2E-CLOSURE-01  
**Companion**: `docs/api/HANDYMAN_BACKEND_API_HANDOFF.md` (shared transport contract, permissions, conventions — read first), `docs/api/openapi.yaml` (1411 paths, 174 `/handyman`).  
**Claim boundary**: Backend-repository evidence only. **No cross-repository E2E PASS is claimed;** worker-app availability waits on the Handyman-Mobile repo integrating these contracts.

## Audience

Handyman-Mobile (worker / field crew). The worker field lane is **authentication-only**: the service enforces the CURRENT Crew Lead / assigned worker. **Never add RBAC shortcuts for the worker app** — there is no tenant RBAC in the field lane.

## Transport contract (all endpoints)

Base `…/api/v1`; `Authorization: Bearer <sessionToken>` from `POST /api/v1/auth/login` (`{ email, password }`).  
Envelopes/statuses as in the shared contract: 401 · 403 · 404 · 409 · 400 (`error.details[]`).  
Every mutating command takes `idempotencyKey`; same key + different payload → 409. All amounts server-derived; references only.

## Mobile endpoint map (auth-only field lane)

| Capability | Endpoint | Method | Gate | Notes |
|---|---|---|---|---|
| Worker profile | `GET /handyman/field/me` | GET | auth (current worker) | |
| Worker profile | `GET /handyman/field/workers/:id/profile` | GET | auth | projection only |
| Field evidence | `POST /handyman/field/evidence/upload` | POST | auth (assigned worker) | bytes; server verifies sha256/size |
| Field evidence | `GET /handyman/field/evidence/:id/bytes\|content\|confirm` | GET | auth | per scope/request |
| Work sessions | `POST /handyman/work-sessions/:id/check-in\|start-work\|pause\|material-run\|resume\|complete\|check-out` | POST | auth = CURRENT Crew Lead | active scope assignment required |
| Work sessions | `GET …/active`, `GET /handyman/work-sessions/:id/time-projection` | GET | auth | |
| Materials | `handyman-material-execution` routers | — | auth | estimate→approve→issue→purchase→use→return→settle; settled quantities read-only for pricing |
| Variations | `handyman-scope-variations` routers | — | auth | propose/decide ADD/REDUCE bound to scope |
| Worker BAST | `POST /handyman/field/execution-scopes/:id/bast/prepare` | POST | auth (crew Lead) | guarded: CURRENT guarded Supervisor QC PASS + work sessions + verified bytes (0445) |
| Worker BAST | `POST /handyman/field/bast/:id/issue\|void`, `GET /handyman/field/execution-scopes/:id/bast` | POST/GET | auth | |
| Warranty rework | `POST /handyman/service-warranty-claims/:claimId/reworks` → `…/reworks/:reworkId/start\|complete\|verify` | POST | auth (Crew Lead) | `verify` binds same-scope evidence + a PASSED QC run; `authorize` stays customer-side |

## Conventions Mobile must respect

- Work Start ≠ Crew Check-In; Presence Time ≠ Billable Time; QR/location identifier alone is not proof of presence (arrival verification semantics are Handyman-owned, shared attendance/location/access engines are infrastructure only).
- QC PASS/FAIL and BAST ISSUE/VOID are server-evaluated; the client sends references + `idempotencyKey` only, never claimed states or amounts.
- A `409` on a replayed idempotency key with a different body is a conflict, not a retry signal.

Contract source of truth: `docs/api/openapi.yaml`. Integration questions cite path + `error.code`.
