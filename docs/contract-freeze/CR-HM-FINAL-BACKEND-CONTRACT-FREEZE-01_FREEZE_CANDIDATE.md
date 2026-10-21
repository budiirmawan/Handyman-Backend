# CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 — Backend Contract Freeze Candidate

| Field | Value |
|---|---|
| Repository | `budiirmawan/Handyman-Backend` **only** |
| Baseline | `main` @ `38e779f87840c3e45b60f179d6b912f505a79fac` (PR #51 merge, CR-HM-BACKEND-CONTRACT-FREEZE-02) |
| Contract version | **Freeze Candidate v1.2** (lineage: v1.0 freeze-01 → v1.1 freeze-02/PR #51 → **v1.2 CR-HM-BACKEND-CONTRACT-FREEZE-03**) |
| OpenAPI | `docs/api/openapi.yaml` — OpenAPI 3.0.3, **1494 paths / 1985 operations / 2256 schemas / 269 `/handyman` operations**, all `operationId`s unique, all local `$ref`s resolve (verified 2026-10-21 by freeze-03: 269/269 documented **and** fully permission/error/security-annotated — 179 `x-required-permission`, 269 `x-error-codes`, 268 security requirements + 1 intentional `security: []`) |
| OpenAPI SHA-256 | `f2ffec3f0bc3e4aa5db74265caeb0738b530aee0c43ca9c4e299866831d70352` — hash of the file **as amended by CR-HM-BACKEND-CONTRACT-FREEZE-03** (this PR; supersedes the v1.1 pin `99b08914…e0d4a6b`). Recompute at merge time; any later spec edit invalidates this pin. |
| Migrations | **459 registered** in `src/database/migrations/index.ts`, head `0460_handyman_settlement_dispute_adjudication`; `0449` intentionally unclaimed/reserved (0450 header). Freeze-03 touched no migration. |
| Runtime census | **269 Handyman runtime operations; 269 documented in OpenAPI, 0 route-only (FG-01 CLOSED 2026-10-21)**; 0 OpenAPI Handyman operations missing from runtime. Freeze-03 re-verified live parity and changed **no runtime behavior** (documentation/schema-shape only; see freeze-03 changelog §2). |
| Status | **FREEZE CANDIDATE — NOT FINAL FREEZE** |

## 1. What is frozen in this candidate

1. Transport: base `/api/v1`, opaque Bearer session (`POST /api/v1/auth/login {email,password}` → `sessionToken`; `SESSION_TTL_MINUTES` default 480), envelope `{success:true,data,meta?}` / `{success:false,error:{code,message,details?,requestId}}`, `X-Request-ID` on every response.
2. Error semantics: 400 `VALIDATION_ERROR` (+ `error.details[]`), 401 unauthenticated, 403 `PERMISSION_DENIED`/`BUILDING_ACCESS_DENIED`, 404 unknown-or-out-of-scope (never enumerates other tenants), 409 state/idempotency conflicts. Exact per-operation codes for cancellation/dispute are in `docs/api/CR-HM-18_FRONTEND_HANDOFF.md` §2–3.
3. Idempotency: every mutating Handyman command takes `idempotencyKey` (1–200 chars); same key+same payload → original result `replayed:true`; same key+different payload → 409. Optimistic concurrency via `expectedVersion`+`reason` where the route requires it.
4. Money law: server-derived amounts only; consumers send references. Money is canonical decimal strings; quotation amounts bind to the APPROVED immutable version.
5. RBAC permission set (seeded/registered by migrations, notably 0442/0446/0448/0450): `tenant_company.read|manage`, `handyman.care.building`, `handyman.commercial.manage`, `handyman.finance.read|manage`, `handyman.settlement.manage`, `handyman.qc.manage|configure`, `handyman.bast.manage`, `finding.close` (+ platform `user/role/permission/building.*`). Exact-Building scoping (`user_building_assignments`); no same-Client shortcut; worker field lane is **authentication-only** with service-enforced Crew Lead/assigned-worker authority. `directTenantLogin: false` (Tenant/PIC act via Customer Care binding — `docs/HANDYMAN_JOURNEY_LIFECYCLE.json`, CR-HM-TENANT-ACTOR-01). **Freeze-03 precision:** quotation and scope-variation tenant decisions are **PIC-personal** service authority (`assertHandymanTenantDecisionActor`): only the platform User linked to the request's immutable Tenant PIC may decide — Customer Care/Operations cannot record, proxy or override them (403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`); BAST sign-off, warranty claim open/submit/withdraw, rework authorize and chargeable accept/reject are **staff transports** that record the staff actor and never impersonate the PIC. Per-operation authority is now machine-visible: 179 ops carry `x-required-permission`; the 90 composite-authority ops state their rule in prose by design (freeze-03 changelog §1.2–1.3).
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
| Freeze-03 spec integrity (parse, census, dup IDs, `$ref`s, annotation counts, error-vocab membership, looseness rescan, parity) | **ALL PASS**; structural diff vs v1.1: 0 ops added/removed, 0 non-Handyman ops changed, 14 schemas tightened, 54 added |
| `tests/handyman-contract-freeze-03-openapi.test.ts` (new, freeze-03) | **13/13** |
| Freeze-03 OpenAPI closure batch (`audit-part05-openapi`, `handyman-bast-worker-read-openapi`, `handyman-handoff-care-actor-openapi`, `handyman-payment-proof-openapi`, `material-chain-openapi`, `mobile-openapi-completeness`) | **32/32** |
| Freeze-03 lifecycle/authority on real DB (`handyman-service-requests`, `handyman-quotation-decision`, `handyman-scope-variations`, `handyman-care-workspace-request-detail`, `handyman-customer-care-warranty`, `handyman-financial-read-part04`, `handyman-e2e-financial-reconciliation-close`, `handyman-field-feed-contract`; embedded PG) | **all green** |
| Pre-existing baseline failures (FG-10; identical on pristine `main@38e779f`, verified in a clean worktree) | 24 tests / 7 suites — see gap register FG-10; freeze-03 delta is **zero** |

No full-suite run was performed (per instructions; 833 test files). No production migration, deployment, or cross-repository verification was performed.

## 3. Changes made by this CR (only confirmed gaps; no duplicate engines)

1. **Master-data OpenAPI merge (P1, FG-02 closed):** the 17 registered paths from `docs/api/CR-HM-MASTER-IND-01_OPENAPI.yaml` and `docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` that were absent from the main spec (apartment units/parties, tenant-import lifecycle, tenant/PIC verification, service-catalogue variants/material-profiles, care request parties) are now in `docs/api/openapi.yaml`, with their parameters/responses/schemas (25 new schemas; refs all resolve; operationIds stay unique). The two supplemental files remain as provenance. `verificationStatus` was additively added to `PublicTenantCompany`/`PublicTenantPic` (the runtime projection already returns it).
2. **OpenAPI contract test fix (FG-07 closed):** `tests/openapi-contract.test.ts` probed the WhatsApp webhook under `/api/v1` although `src/app.ts` mounts it outside the prefix and only when enabled; the test now enables it with test-only secrets and probes its real mount. No production gate changed.
3. **Stale handoff correction (FG-08 closed):** `docs/api/HANDYMAN_BACKEND_API_HANDOFF*.md` claimed request `CANCELLED` did not exist and cited 1411 paths/457 migrations/head 0458; corrected to the merged PR #48/#50 reality.
4. This document set (reconciliation, schema candidate, gap register, scenario pack, three versioned consumer handoffs).
5. **FG-01 closure (CR-HM-BACKEND-CONTRACT-FREEZE-02, this PR):** the 67 formerly route-only Handyman operations (Care authority/communications/standalone payments & proof, dispatch, canonical identity, visits/inspector/slot-consent, finance close & invoice reconciliation, material-purchases, scope variations, field evidence, field feed, worker profile) are now defined in `docs/api/openapi.yaml` with exact schemas derived from the route validation, service input/return types and error-code sources — no invented schemas, no production behavior change. The three consumer handoffs now cite the new `operationId`s for every row. Migration-collision reconciliation (FG-05) is documentation-only: PR #47 remains OPEN/unmerged, its `0459` number stays taken by `0459_handyman_request_cancellation`, renumber ≥0461 if revived; no historical migration was touched.
6. **Consistency reconciliation (CR-HM-BACKEND-CONTRACT-FREEZE-03, this PR):** closes the gaps reported after Frontend synchronized the v1.1 spec. (a) `CANCELLED` joined `HandymanServiceRequestStatus` (runtime since PR #48) without touching transitions or `previousStatus`; (b) permission/error/security annotation completed for all 269 ops (FG-02 closed) — AST-derived error sets with phantom codes removed (`HANDYMAN_VARIATION_FORBIDDEN` never existed), 11 service-enforced permissions annotated, `tenantSlotAssertionSignature` scheme defined; (c) decision-authority prose corrected to runtime law — variation tenant decision is PIC-personal (freeze-02 wrongly described an Operations recording path), BAST/warranty/chargeable transports clarified as staff-recorded attestation, 31 stale `canAccessClient` claims corrected to BE-02G exact-Building walls; (d) 32 bare finance/warranty payloads typed field-for-field from service return types (+54 components) and `CareHandymanOperationalProjection` typed from its SQL composition; (e) wave handoff snapshots bannered as superseded; version lineage pinned (v1.0/v1.1/v1.2). Exact per-operation matrix + compatibility analysis: `CR-HM-BACKEND-CONTRACT-FREEZE-03_CHANGELOG.md`. Durable guards added in `tests/handyman-contract-freeze-03-openapi.test.ts`. No runtime behavior, migration or authority changed (four route-header comments corrected to match).

## 4. Why this is NOT a FINAL FREEZE

Per the strict instruction, FINAL FREEZE requires consumer contract compatibility and staging E2E, neither verifiable from this repository:

- FG-01: **CLOSED** by CR-HM-BACKEND-CONTRACT-FREEZE-02 (PR #51) — 269/269 Handyman operations documented; see gap register.
- FG-02: **CLOSED** by CR-HM-BACKEND-CONTRACT-FREEZE-03 (this PR) — annotation policy complete (179 single-permission ops annotated; 90 composite-authority ops documented in prose by design; 269/269 error sets; 269/269 security decisions).
- FG-03: Frontend #33, Operations #22/#23, Mobile #14 are **reported** merged in their repositories; this CR did not and cannot verify them (one-repository rule).
- FG-04: staging migration status and staging E2E have not been run; the pending-migration subset for any real environment is unknown until `npm run db:migrate:status` is run there (read-only).
- FG-05: open PR #47 (bank-receipt attestation) is excluded and now collides on migration number 0459.

**Sequential consumer integration order:** Frontend (Customer Care) → Operations → Mobile, each against this candidate + its handoff, then a joint staging E2E using `CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_E2E_ACCEPTANCE_SCENARIO_PACK.md`. Only after all three report compatibility and staging E2E passes may a follow-up CR declare FINAL FREEZE.
