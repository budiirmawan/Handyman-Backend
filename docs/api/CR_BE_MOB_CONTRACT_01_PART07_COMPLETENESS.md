# CR-BE-MOB-CONTRACT-01 PART 07 — OpenAPI Mobile Contract Completeness

> **Status:** PART 07 — completeness review + residual gap closure (contract
> only). No endpoint, domain logic, or workflow change.
> **Baseline:** Arena branch `arena/01a01872-asentra-backend` on top of
> PART 01–06.
> **Date:** 2026-08-19

## 1. Objective

Final completeness review of the backend OpenAPI contract required by
Asentra Mobile across the 14 mobile-consumed capability categories, with a
route-level completeness diff and closure of the safe residual documentation
gaps where the backend implementation already exists.

## 2. Classification legend

- **PUBLISHED** — the backend route exists AND is documented in
  `docs/api/openapi.yaml` with request/response schemas, RBAC, and Building
  isolation requirements.
- **PARTIAL** — the backend route exists and is partly documented (e.g. read
  published, mutation missing) but was closed in PART 07.
- **NOT_APPLICABLE** — the backend route exists but is outside the mobile
  operational contract scope (management/administration surfaces of other
  domains, or domains not consumed by mobile operational users).
- **GAP** — a mobile-consumed capability that the backend does not implement
  (documented as such; no implementation fabricated).

## 3. Completeness matrix

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Authentication & Session | **PUBLISHED** | login/me/logout/audit/me-buildings (PART 01) |
| 2 | User / Role / Permission / Entitlement | **PUBLISHED** | users/roles/permissions (PART 02) + entitlements (PART 07) |
| 3 | Client / Property / Building Context | **PUBLISHED** | clients/properties/buildings + assignments (PART 02) |
| 4 | Task & Work Order | **PUBLISHED** | task read/assign/execution (PART 03) + work order read (PART 03) + work order execution actions / evidence / verification / history / management (PART 07) |
| 5 | Checklist | **PUBLISHED** | execution + template/item (PART 04) |
| 6 | Measurement & UOM | **PUBLISHED** | UOM CRUD + measurement binding (PART 04) |
| 7 | Evidence | **PUBLISHED** | submission metadata + file upload/download + requirements (PART 04) |
| 8 | Finding | **PUBLISHED** | list/create/detail/state/source/cancel (PART 05) |
| 9 | Rework | **PUBLISHED** | rework/reject/resubmit (PART 05) |
| 10 | Supervisor Verification | **PUBLISHED** | finding reviews/verification + mobile/verification (PART 05) |
| 11 | QR Resolution | **PUBLISHED** | mobile/qr + assets/resolve (PART 06) |
| 12 | Location / Functional Location | **PUBLISHED** | hierarchy + floors/areas/rooms/spaces/functional-locations (PART 06) |
| 13 | Asset / Equipment Context | **PUBLISHED** | asset + location + status + identifiers + history + warranties + certifications + equipment profile (PART 06 + PART 07) |
| 14 | Operational Context | **PUBLISHED** | operational-events list + by-id (PART 07) |

## 4. Routes reviewed

- **Total backend route registrations:** 1,345 (over `src/modules/**` +
  `src/routes/**`).
- **Documented in OpenAPI:** 344 paths / 452 operations (all with unique
  `operationId`, all `$ref`s resolving).
- **Mobile-consumed (14 categories) pinned in the completeness test:** 180
  operations — all PUBLISHED.

## 5. Gaps closed in PART 07

The following mobile-consumed surfaces were implemented by the backend but
undocumented; PART 07 published them (all reusing existing DTOs):

- **Work Order execution actions** (POST acknowledge/start/hold/resume/notes/
  cancel/complete) — the mobile technician execution surface already
  referenced by `GET /mobile/assignments` → `availableActions`.
- **Work Order evidence** (GET/POST evidence, GET evidence-requirements,
  PATCH evidence/:id) — BE-08G.
- **Work Order verification** (GET/POST verification) — BE-08I.
- **Work Order history** (GET history) — BE-08J.
- **Work Order management mutations** (PATCH work-order, priority, status,
  context, bast-requirement; POST/PATCH assignments) — BE-08B/C/D/E.
- **Task assignment** (POST /tasks/:taskId/assignments, PATCH
  /tasks/:taskId/assignments/:assignmentId) — BE-07.
- **Entitlement** (GET /entitlements, GET/PATCH /entitlements/:id(/status),
  GET/POST /subscriptions/:id/entitlements(/effective)) — BE-02C.
- **Asset sub-resource reads** (GET status, identifiers, history, warranties,
  certifications) — BE-05E/F/G/H/I.
- **operational-events/:id** (GET) — BE-07 operational timeline.

## 6. Remaining GAP items (backend does not implement; not fabricated)

| Gap | Detail |
|---|---|
| QR target types beyond `ASSET` | `targetType` discriminator is `ASSET` only; room/floor/space/functional-location QR resolution is not implemented. |
| GPS / geofencing | Backend has no device-GPS or geofencing authority (mobile-side concern; documented, not modeled). |
| Offline evidence byte queue | `POST /mobile/sync` carries evidence metadata only; bytes upload stays on the online endpoints. |
| Direct single-resource `availableActions` for Work Order / Task | Only via `GET /mobile/assignments` (unified feed); no standalone endpoint. |

## 7. NOT_APPLICABLE (out of mobile operational scope)

Domains whose backend routes exist but are not part of the 14 mobile-consumed
categories (management/administration, or separate domains): inventory,
procurement (beyond the R2P chain already published), utility, security,
housekeeping, tenant, vendor, workforce reporting, engineering/patrol
bindings, notifications (BE-26, published separately), configuration studio
(BE-27, published separately), BAST, and reporting/export.

## 8. Verification

- `npm run typecheck` — pass.
- `openapi-contract`, `r2p-openapi-contract`, `material-chain-openapi`,
  `error-contract` — pass.
- PART 01–06 mobile contract regression — pass.
- PART 07 completeness test (5 subtests): pinned-matrix coverage, reverse
  drift (documented-only-if-registered), unique operationIds, all `$ref`s
  resolve, bearer-security coverage — pass.
- `git diff --check` — clean.
