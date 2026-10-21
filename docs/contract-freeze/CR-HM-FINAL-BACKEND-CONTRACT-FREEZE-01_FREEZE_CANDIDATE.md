# CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 — Backend Contract Freeze Candidate

| Field | Value |
|---|---|
| Repository | `budiirmawan/Handyman-Backend` **only** |
| Baseline | `main` @ `8b80f9268b173a525eb74fd9cae85740e0b7d228` (PR #50 merge; PR #48 and PR #50 verified MERGED via `gh pr list`) |
| Contract version | **Freeze Candidate v1.0** (this document set) |
| OpenAPI | `docs/api/openapi.yaml` — OpenAPI 3.0.3, **1494 paths / 1985 operations / 2202 schemas / 241 `/handyman` paths / 269 `/handyman` operations**, all `operationId`s unique, all local `$ref`s resolve (verified 2026-10-21; freeze-01 pin was 1432/1918, CR-HM-BACKEND-CONTRACT-FREEZE-02 added the 67 formerly route-only Handyman operations) |
| OpenAPI SHA-256 | `99b089144a25322de4ccf17f56ae0078ff486789bd829aa19f5f7dc67e0d4a6b` — hash of the file **as amended by CR-HM-BACKEND-CONTRACT-FREEZE-02** (PR #51). Recompute at merge time; any later spec edit invalidates this pin. |
| Migrations | **459 registered** in `src/database/migrations/index.ts`, head `0460_handyman_settlement_dispute_adjudication`; `0449` intentionally unclaimed/reserved (0450 header) |
| Runtime census | **269 Handyman runtime operations; 269 documented in OpenAPI, 0 route-only (FG-01 CLOSED 2026-10-21)**; 0 OpenAPI Handyman operations missing from runtime |
| Status | **FREEZE CANDIDATE — NOT FINAL FREEZE** |

## 1. What is frozen in this candidate

1. Transport: base `/api/v1`, opaque Bearer session (`POST /api/v1/auth/login {email,password}` → `sessionToken`; `SESSION_TTL_MINUTES` default 480), envelope `{success:true,data,meta?}` / `{success:false,error:{code,message,details?,requestId}}`, `X-Request-ID` on every response.
2. Error semantics: 400 `VALIDATION_ERROR` (+ `error.details[]`), 401 unauthenticated, 403 `PERMISSION_DENIED`/`BUILDING_ACCESS_DENIED`, 404 unknown-or-out-of-scope (never enumerates other tenants), 409 state/idempotency conflicts. Exact per-operation codes for cancellation/dispute are in `docs/api/CR-HM-18_FRONTEND_HANDOFF.md` §2–3.
3. Idempotency: every mutating Handyman command takes `idempotencyKey` (1–200 chars); same key+same payload → original result `replayed:true`; same key+different payload → 409. Optimistic concurrency via `expectedVersion`+`reason` where the route requires it.
4. Money law: server-derived amounts only; consumers send references. Money is canonical decimal strings; quotation amounts bind to the APPROVED immutable version.
5. RBAC permission set (seeded/registered by migrations, notably 0442/0446/0448/0450): `tenant_company.read|manage`, `handyman.care.building`, `handyman.commercial.manage`, `handyman.finance.read|manage`, `handyman.settlement.manage`, `handyman.qc.manage|configure`, `handyman.bast.manage`, `finding.close` (+ platform `user/role/permission/building.*`). Exact-Building scoping (`user_building_assignments`); no same-Client shortcut; worker field lane is **authentication-only** with service-enforced Crew Lead/assigned-worker authority. `directTenantLogin: false` (Tenant/PIC act via Customer Care binding — `docs/HANDYMAN_JOURNEY_LIFECYCLE.json`, CR-HM-TENANT-ACTOR-01).
6. State machines ( §2 of each consumer handoff; source of truth is the service layer, never client-hardcoded transitions).
7. Schema candidate: § `CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_SCHEMA_FREEZE_CANDIDATE.md`.

## 2. Verification performed for this candidate (Backend only, disposable PostgreSQL)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `tests/handyman-e2e-capability-closure.test.ts` (J01 cancel + J12 dispute, PR #48) | 4/4 |
| `tests/handyman-e2e-finance-close-api.test.ts` (full J03→J12 guarded HTTP lifecycle) | 6/6 |
| `tests/handyman-e2e-financial-reconciliation-close.test.ts` (FINAL CLOSE + DP) | 2/2 |
| `tests/cr-hm-master-ind-01.test.ts` (0456 master data) | 9/9 |
| `tests/cr-hm-master-tenant-batch-01.test.ts` (0457 Tenant/PIC batch) | 9/9 |
| `tests/cr-hm-be-client-master-01.test.ts` (Client master) | 10/10 |
| `tests/openapi-contract.test.ts` | 7/7 **after this CR's fix** (was 6/7 on baseline — FG-07) |
| Runtime↔OpenAPI census (`tests/helpers/openapi-census.ts`) | Freeze-01: 269 Handyman ops; 67 route-only; 0 phantom → **Freeze-02 (PR #51): 269/269 documented; 0 missing; 0 phantom; 0 duplicate operationIds; 0 broken refs; focused OpenAPI/contract suites 31/31; `npx tsc --noEmit` PASS** |

No full-suite run was performed (per instructions; 833 test files). No production migration, deployment, or cross-repository verification was performed.

## 3. Changes made by this CR (only confirmed gaps; no duplicate engines)

1. **Master-data OpenAPI merge (P1, FG-02 closed):** the 17 registered paths from `docs/api/CR-HM-MASTER-IND-01_OPENAPI.yaml` and `docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` that were absent from the main spec (apartment units/parties, tenant-import lifecycle, tenant/PIC verification, service-catalogue variants/material-profiles, care request parties) are now in `docs/api/openapi.yaml`, with their parameters/responses/schemas (25 new schemas; refs all resolve; operationIds stay unique). The two supplemental files remain as provenance. `verificationStatus` was additively added to `PublicTenantCompany`/`PublicTenantPic` (the runtime projection already returns it).
2. **OpenAPI contract test fix (FG-07 closed):** `tests/openapi-contract.test.ts` probed the WhatsApp webhook under `/api/v1` although `src/app.ts` mounts it outside the prefix and only when enabled; the test now enables it with test-only secrets and probes its real mount. No production gate changed.
3. **Stale handoff correction (FG-08 closed):** `docs/api/HANDYMAN_BACKEND_API_HANDOFF*.md` claimed request `CANCELLED` did not exist and cited 1411 paths/457 migrations/head 0458; corrected to the merged PR #48/#50 reality.
4. This document set (reconciliation, schema candidate, gap register, scenario pack, three versioned consumer handoffs).
5. **FG-01 closure (CR-HM-BACKEND-CONTRACT-FREEZE-02, this PR):** the 67 formerly route-only Handyman operations (Care authority/communications/standalone payments & proof, dispatch, canonical identity, visits/inspector/slot-consent, finance close & invoice reconciliation, material-purchases, scope variations, field evidence, field feed, worker profile) are now defined in `docs/api/openapi.yaml` with exact schemas derived from the route validation, service input/return types and error-code sources — no invented schemas, no production behavior change. The three consumer handoffs now cite the new `operationId`s for every row. Migration-collision reconciliation (FG-05) is documentation-only: PR #47 remains OPEN/unmerged, its `0459` number stays taken by `0459_handyman_request_cancellation`, renumber ≥0461 if revived; no historical migration was touched.

## 4. Why this is NOT a FINAL FREEZE

Per the strict instruction, FINAL FREEZE requires consumer contract compatibility and staging E2E, neither verifiable from this repository:

- FG-01: **CLOSED** by CR-HM-BACKEND-CONTRACT-FREEZE-02 (this PR) — 269/269 Handyman operations documented; see gap register.
- FG-03: Frontend #33, Operations #22/#23, Mobile #14 are **reported** merged in their repositories; this CR did not and cannot verify them (one-repository rule).
- FG-04: staging migration status and staging E2E have not been run; the pending-migration subset for any real environment is unknown until `npm run db:migrate:status` is run there (read-only).
- FG-05: open PR #47 (bank-receipt attestation) is excluded and now collides on migration number 0459.

**Sequential consumer integration order:** Frontend (Customer Care) → Operations → Mobile, each against this candidate + its handoff, then a joint staging E2E using `CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_E2E_ACCEPTANCE_SCENARIO_PACK.md`. Only after all three report compatibility and staging E2E passes may a follow-up CR declare FINAL FREEZE.
