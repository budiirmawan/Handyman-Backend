# CR-HM-BACKEND-CONTRACT-FREEZE-03 — Contract Changelog & Compatibility Report

| Field | Value |
|---|---|
| Repository | `budiirmawan/Handyman-Backend` **only** (one-repository rule; no cross-repo verification) |
| Baseline | `main` @ `38e779f87840c3e45b60f179d6b912f505a79fac` (PR #51 merge = CR-HM-BACKEND-CONTRACT-FREEZE-02) |
| Contract version | **Freeze Candidate v1.2** (v1.0 freeze-01 → v1.1 freeze-02/PR #51 → v1.2 freeze-03) |
| Status | **FREEZE CANDIDATE — NOT FINAL FREEZE** (FG-03 consumer compatibility + FG-04 staging E2E still open) |
| OpenAPI before | `docs/api/openapi.yaml` SHA-256 `99b089144a25322de4ccf17f56ae0078ff486789bd829aa19f5f7dc67e0d4a6b` |
| OpenAPI after | `docs/api/openapi.yaml` SHA-256 `f2ffec3f0bc3e4aa5db74265caeb0738b530aee0c43ca9c4e299866831d70352` (1494 paths / 1985 ops / **2256 schemas**; 269 Handyman ops) |
| Runtime behavior | **Unchanged.** No route, guard, transition, DTO or migration was modified. The only source edits are four route-header **comments** (§6). Migrations untouched (459 registered, head `0460_handyman_settlement_dispute_adjudication`, `0449` reserved). |
| Method | Systematic source-vs-spec audit: runtime route census (`tests/helpers/openapi-census.ts`), RBAC guard census, TS-AST error-code derivation from handler→service call graphs with per-code manual adjudication, TS-AST return-type→schema conversion, and migration/SQL-derived projection typing. Line-based spec patching only (the file is not round-trip-stable under YAML serialization). |

## 1. What changed (by objective)

### 1.1 Request-status enum reconciled with the implemented CANCELLED lifecycle
- `HandymanServiceRequestStatus` now includes **`CANCELLED`** (7 values), matching the runtime vocabulary `HANDYMAN_SERVICE_REQUEST_STATUSES` and migration 0459. Both `REFERRED` and `CANCELLED` are terminal; `CANCELLED` is reachable only pre-commitment (no execution scope). No runtime transition changed.
- `listCareWorkspaceRequests`' inline stale 6-value `status` copy replaced by `$ref` to the component (three other list ops already referenced it).
- `HandymanRequestCancellation.previousStatus` **deliberately unchanged** (5 pre-cancellation states; it records the state *before* cancellation and can never be `CANCELLED`/`REFERRED`). `reason`/`idempotencyKey` gained their proven migration bounds (1–500 / 1–200).
- Five response fields that project `handyman_service_requests.status` but were plain strings now `$ref` the frozen vocabulary: `HandymanStatusVisibilityReadView.stages.request.status`, `CanonicalHandymanIdentity.serviceRequest.status`, `HandymanFieldJob.requestStatus`, `HandymanFieldScopeDetail.workOrder.requestStatus`, `HandymanFieldRequestDetail.request.status` — plus `CareHandymanOperationalProjection.request.status`.

### 1.2 Permission / error-code / security annotation completion (closes FG-02)
Counts over the 269 Handyman operations (freeze-02 → freeze-03): `x-required-permission` **35 → 179**; `x-error-codes` **57 → 269**; explicit `security` **176 → 269** (268 requirements + 1 intentional `security: []`).

- **Permission rule:** `x-required-permission` is set only where ONE permission names the whole authority — a route `requirePermission(...)` guard (167 ops), the first guard of the one dual-guard op (`executeHandymanManagerFinalClose`: `finding.close`, with `handyman.finance.read` documented in prose), or an unconditional service-enforced permission (11 ops). The other 90 ops are **composite authority** (current Crew Lead / assigned worker, Care workspace session + occupancy, HMAC doors) and deliberately carry **no** `x-required-permission` — naming a single permission there would be false. Their authority is stated in each description. Only 10 distinct permissions are named; all are seeded (`FOUNDATION_PERMISSIONS`): `finding.close`, `handyman.bast.manage`, `handyman.care.building`, `handyman.commercial.manage`, `handyman.finance.manage`, `handyman.finance.read`, `handyman.qc.configure`, `handyman.settlement.manage`, `tenant_company.manage`, `tenant_company.read`.
- The 11 service-enforced annotations: QC checklist publish/list/bind → `handyman.qc.configure`; variation operations-review / revised-quotation / authorize / final-charge → `tenant_company.manage`, variation operations list → `tenant_company.read`; material purchase approve/reconcile → `tenant_company.manage`, material operations list → `tenant_company.read`.
- **Error codes:** every op now declares the domain codes its own handler→service call graph can throw (AST-derived, then manually pruned for semantic reachability — e.g. codes swallowed by `readOptional` aggregation in standalone Care detail/progress are excluded there). Framework generics from middleware (401/403 permission/building/5xx) are not duplicated. 15 ops in the finance-read/service-warranty families document a domain `*_VALIDATION` code instead of generic `VALIDATION_ERROR` (their services validate exclusively through domain factories); `getMyHandymanWorkerProfile` is input-free.
- **Security:** new scheme **`tenantSlotAssertionSignature`** (`apiKey`, header `x-handyman-tenant-slot-signature`) documents the existing server-to-server HMAC door `acceptTenantSlotChoice` (previously referenced but undefined). `uploadCareWorkspaceRequestPaymentProof` corrected `bearerAuth` → `careWorkspaceSession`. The single intentional `security: []` remains `createCareHandymanServiceRequest` (the exchange token in the body is the credential). Distribution: 251 `bearerAuth`, 15 `careWorkspaceSession`, 1 `handoffAssertionSignature`, 1 `tenantSlotAssertionSignature`, 1 none.
- **Phantom codes removed** from annotations/prose (all verified nonexistent or unreachable on those ops): `HANDYMAN_VARIATION_FORBIDDEN` (never existed — the code is `HANDYMAN_VARIATION_ROLE_FORBIDDEN`); payment-proof read-path `NOT_FOUND`/`INTEGRITY_CONFLICT` on the upload op; `HANDYMAN_SERVICE_REQUEST_NOT_FOUND` on Care communications (generic `NOT_FOUND` by design); idempotency-conflict codes listed on material/variation ops that never reach the idempotency store; field-evidence `…_VERIFICATION_FAILED` on confirm (actual: `HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED`).

### 1.3 Tenant/PIC decision authority & Care boundaries (documentation corrected to runtime law)
- **`recordHandymanVariationTenantDecision` was misdocumented in freeze-02** as an Operations/Manager recording endpoint ("the tenant never calls this API"). The runtime has always enforced the opposite: it is **PIC-personal** (`assertHandymanTenantDecisionActor`) — the caller must be the platform User linked to the request's immutable Tenant PIC (ACTIVE PIC + ACTIVE company + current occupancy), with **no staff recording path, no delegation, no Care override** (else 403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`). Summary + description rewritten. `decideHandymanQuotation` gained the same explicit authority paragraph (its runtime rule is identical, on top of the `tenant_company.manage` route guard).
- **Staff-transport decisions clarified** (they record the staff actor and never impersonate the Tenant PIC; represented tenant stays server-resolved; customer consent/signature is attested data): BAST accept/reject/sign-off, warranty claim open/submit/withdraw, rework authorize (customer-side acceptance), chargeable additional-work accept/reject (staff actor persisted as decision actor), customer-payment record. Claim approve/reject are marked **provider-side adjudication**. BAST sign-off additionally documents the conditionally-required `signatureDigest` (409 `HANDYMAN_BAST_SIGNATURE_REQUIRED`) that the schema cannot express, and the same-scope rule for `evidenceRecordId`.
- **Care impersonation:** nothing grants it. Care doors stay exactly as runtime: `careWorkspaceSession` (≤15-min opaque credential), `handoffAssertionSignature` (admission), standalone Care Bearer (`handyman.care.building` + exact-Building), `directTenantLogin: false`. No identity is accepted from request bodies.
- **BE-02G access wording corrected on 31 operations.** Freeze-02 prose cited the retired client-level `canAccessClient` wall (33 ops scanned); per-service verification shows 30 of them enforce **exact-Building** access to the resource's server-derived Building (a same-Client sibling-Building assignment does NOT suffice) since CR-HM-SEC-01. One is dual-path (`listHandymanProviderAvailability`). Only 4 descriptions legitimately still cite the client-level check (the request list's per-row predicate wall, the client-basis ledger read, provider performance, availability's clientId-only path) — pinned by the new contract test so the stale phrase cannot spread again.

### 1.4 Response schema tightening (no invented schemas)
- **32 bare-object payloads typed** (finance-close API passes service results verbatim to `sendSuccess`): **54 new components** — 48 converted field-for-field from the TS return/record types (commercial agreement, labor/material pricing bases, BM-fee rule/term/beneficiary, pricing contract + BM-fee configuration, customer transaction/charge-line, payment allocation, ledger corrections, financial entitlements derivation, financial reads, service warranty start/expire) and 6 settlement literal results (`{unitId,state,replayed}`, `{id,outcome,cause,variance,replayed}`, `{id,kind,replayed}` with exact enums). The 4 warranty-rework commands now wire to the pre-existing `HandymanServiceWarrantyReworkCommandResult` (verified identical to the TS type). Money/decimals remain strings (pg NUMERIC); `*At` fields are `date-time`.
- **`CareHandymanOperationalProjection` fully typed**: all 12 previously open nested shapes replaced with the exact objects the one-statement SQL composition emits (`care-workspace-operational.repository.ts`) — quotation versions+lines, readiness, appointments, evidence+files, QC runs+items, defects, BAST+events+sign-offs, invoice+lines, derived `paymentStatus` (status enum exactly `CANCELLED|NOT_DERIVED|PAID|OVERDUE|PARTIALLY_PAID|UNPAID`), payments+proofs, warranty coverages/claims/reworks, activity timeline. Nullability and vocabularies come from the owning migrations' column/CHECK definitions; `maxItems` mirrors the SQL caps; every nested object is `additionalProperties: false` with all keys required (`jsonb_build_object` always emits them).
- `listStandaloneCareRequests`' empty-meta branch closed to exactly `{}` (`maxProperties: 0`).
- Genuinely open JSONB bags are now honestly labelled instead of silently loose: event `metadata` (QC/defect/material-purchase/scope-variation events) and `HandymanDispatchRelease.readinessSnapshot` are documented as opaque audit/snapshot data (`additionalProperties: true` retained by design); `SuccessEnvelope.meta` documents the open-map rule (ops narrow it per-response).

### 1.5 Contract version naming & handoff provenance
- Lineage pinned in the spec header: **v1.0 freeze-01 · v1.1 freeze-02 (PR #51) · v1.2 freeze-03**. Platform `info.version` stays `0.1.0` (unchanged convention).
- The two wave snapshot files (`CR-HM-MASTER-IND-01_OPENAPI.yaml`, `CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml`) now carry **superseded banners**; `docs/api/openapi.yaml` is the sole integration contract.
- Tag note: the 13 scope-variation operations remain grouped under the freeze-02 tag `Handyman Material Execution` (uniform within the family; cosmetic, intentionally not rechurned).

## 2. Compatibility impact for consumers

- **Wire behavior: zero change.** No path, method, parameter, request/response shape, status code, or runtime error changed. Clients generated from freeze-02 keep working; regenerating from v1.2 yields richer (compatible) types.
- **Additive schema changes only:** new enum member `CANCELLED` (consumers must tolerate it wherever request status is rendered — it was already emittable by the runtime since PR #48; freeze-02's enum simply lied), 54 new components, `$ref` substitutions for previously open objects. If a consumer had hand-written assumptions from the freeze-02 *prose*, three corrections need attention:
  1. **Variation tenant decision is PIC-personal** — any Operations/Care "record decision on behalf" UX built from the old text cannot succeed; the call must originate from the PIC-linked platform user's own session (same rule as quotation decision). If the product has no PIC login surface, that is a product gap (FG-03), not an API change.
  2. **Exact-Building walls** — a user assigned to *any* Building of a Client does **not** gain the 30 corrected reads/commands; assignment must be to the resource's exact Building (this was already the runtime behavior).
  3. **`signatureDigest` on BAST ACCEPT is effectively required** (409 when missing) although the schema marks it optional.
- **Unknown-field posture:** newly closed schemas set `additionalProperties: false`, reflecting verbatim runtime payloads; consumers should ignore unknown fields on read (server only emits the documented keys today).

## 3. Verification evidence (this CR; disposable embedded PostgreSQL)

| Check | Result |
|---|---|
| Spec integrity script (parse, 269 census, dup IDs, dangling `$ref`s, annotation counts, error vocab, looseness rescan, spec↔runtime parity) | **ALL PASS** |
| Structural diff vs baseline spec | 0 ops added/removed; **0 non-Handyman ops changed**; 14 schemas changed (all §1), 54 added; only `securitySchemes` +1 |
| `tests/handyman-contract-freeze-03-openapi.test.ts` (**new**) | **13/13** — incl. enum bound to `HANDYMAN_SERVICE_REQUEST_STATUSES`, 269 parity vs live router, seeded-permission membership, phantom absence, projection closure |
| OpenAPI closure batch (`audit-part05-openapi`, `handyman-bast-worker-read-openapi`, `handyman-handoff-care-actor-openapi`, `handyman-payment-proof-openapi`, `material-chain-openapi`, `mobile-openapi-completeness`) | **32/32** |
| Lifecycle/authority (`handyman-service-requests`, `handyman-quotation-decision`, `handyman-scope-variations`, `handyman-care-workspace-request-detail`, `handyman-customer-care-warranty`, `handyman-financial-read-part04`, `handyman-e2e-financial-reconciliation-close`, `handyman-field-feed-contract`) | **all green** (real DB evidence, embedded PG) |
| `npx tsc --noEmit` | **PASS** |
| Pre-existing baseline failures (identical before/after; **FG-10**) | 24 tests over 7 suites fail byte-identically on pristine `main@38e779f` — see §4 |

Full-suite run intentionally not performed (833 test files; focused-runs instruction).

## 4. Remaining blockers & readiness

- **FG-03 (P1, blocks FINAL FREEZE):** consumer (Frontend/Operations/Mobile) compatibility is *reported* merged upstream, never verifiable from this repository. Consumers should regenerate from the v1.2 spec (SHA above) and confirm §2 items, then report path+`error.code` discrepancies back.
- **FG-04 (P1, blocks FINAL FREEZE):** no staging migration-status or staging E2E evidence exists yet. Operator must run `npm run db:migrate:status` on staging (read-only), apply any pending subset in registry order, and execute the acceptance scenario pack.
- **FG-05 (P2):** PR #47 still open/excluded; its `0459` collides with `0459_handyman_request_cancellation` — renumber ≥0461 if revived; not imported here.
- **FG-06 (P2):** BAST PSrE/e-signature decisions (SD-01…15) still pending Legal/Product; contract remains authenticated acceptance + `signatureDigest` + same-scope evidence.
- **FG-10 (P2, new): baseline test debt.** 24 tests across `handyman-bast-signoff-scope-guard` (2), `handyman-care-workspace-admission` (1), `handyman-care-workspace-scope` (2), `handyman-field-feed-authority` (14), `handyman-bm-fee-prerequisite-configuration` (1), `handyman-chargeable-additional-work-scope-guard` (2), `handyman-customer-transaction-scope-guard` (2) fail identically on unmodified `main@38e779f` (verified in a clean worktree): scope-guard fixtures still approve quotations with a non-PIC actor (incompatible with the shipped PIC-personal authority), the field-feed TEMP-table fixture predates the dispatch-release feed columns, and two suites pin stale path/migration lists. Freeze-03 neither caused nor fixes them (its scope forbids runtime/test-fixture semantic changes); they must be repaired before those suites can serve as FG-04 staging evidence.

**Readiness:** the Backend contract is **ready for consumer integration against Freeze Candidate v1.2** in the frozen sequence Frontend (Customer Care) → Operations → Mobile. FINAL FREEZE remains blocked solely by FG-03 + FG-04.

## 5. Exact changed `operationId`s (267 of 269; only `cancelHandymanVisitProposal` and `getMyHandymanFieldJobs` were already fully annotated and are untouched)

Legend: `perm+` permission annotation added · `err+` error list added · `err~` error list replaced (phantom-pruned/completed) · `sec+` security added · `sec~` security corrected · `desc` description corrected · `sum` summary corrected · `data` response payload wired to typed component · `other` parameter/meta tightening.

| operationId | Method · Path | Changes |
|---|---|---|
| `postHandymanCommercialAgreement` | POST `/handyman/commercial-agreements` | perm+, err+, data |
| `postHandymanCommercialAgreementVersionActivate` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/activate` | perm+, err+, data |
| `postHandymanCommercialAgreementVersionSupersede` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/supersede` | perm+, err+, data |
| `postHandymanLaborPricingBasis` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/labor-pricing-basis` | perm+, err+, data |
| `postHandymanMaterialPricingBasis` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/material-pricing-basis` | perm+, err+, data |
| `postHandymanBmFeeRule` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-rule` | perm+, err+, data |
| `postHandymanBmFeeTerm` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-term` | perm+, err+, data |
| `postHandymanBmFeeBeneficiary` | POST `/handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-beneficiary` | perm+, err+, data |
| `getHandymanPricingContract` | GET `/handyman/pricing-contract` | perm+, err+, data |
| `getHandymanBmFeeConfiguration` | GET `/handyman/bm-fee-configuration` | perm+, err+, data |
| `postHandymanCustomerTransactionOpen` | POST `/handyman/execution-scopes/{executionScopeId}/customer-transaction` | perm+, err+, data |
| `postHandymanCustomerChargeLine` | POST `/handyman/execution-scopes/{executionScopeId}/customer-charge-lines` | perm+, err+, data |
| `postHandymanPaymentAllocation` | POST `/handyman/execution-scopes/{executionScopeId}/payment-allocations` | perm+, err+, data |
| `postHandymanLedgerRefund` | POST `/handyman/execution-scopes/{executionScopeId}/ledger-refunds` | perm+, err+, data |
| `postHandymanLedgerAllocationReversal` | POST `/handyman/execution-scopes/{executionScopeId}/ledger-reversals/allocation` | perm+, err+, data |
| `postHandymanLedgerPaymentReversal` | POST `/handyman/execution-scopes/{executionScopeId}/ledger-reversals/payment` | perm+, err+, data |
| `postHandymanLedgerAdjustment` | POST `/handyman/execution-scopes/{executionScopeId}/ledger-adjustments` | perm+, err+, data |
| `postHandymanFinancialEntitlementsDerive` | POST `/handyman/execution-scopes/{executionScopeId}/financial-entitlements/derive` | perm+, err+, data |
| `postHandymanSettlementPrepare` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/prepare` | perm+, err+, data |
| `postHandymanSettlementInclude` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/include` | perm+, err+, data |
| `postHandymanSettlementReconcile` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/reconcile` | perm+, err+, data |
| `postHandymanSettlementSettle` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/settle` | perm+, err+, data |
| `postHandymanSettlementDispute` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/dispute` | perm+, err+, data |
| `postHandymanSettlementDisputeResolution` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/dispute/resolution` | perm+, err+ |
| `postHandymanSettlementCorrection` | POST `/handyman/execution-scopes/{executionScopeId}/settlement/correction` | perm+, err+, data |
| `getHandymanFinancialTransaction` | GET `/handyman/execution-scopes/{executionScopeId}/financial-transaction` | perm+, err+, data |
| `getHandymanFinancialTransactions` | GET `/handyman/financial-transactions` | err+, data |
| `listHandymanFinanceActionInbox` | GET `/handyman/finance/action-inbox` | err+ |
| `postHandymanServiceWarrantyStart` | POST `/handyman/execution-scopes/{executionScopeId}/service-warranty/start` | perm+, err+, data |
| `postHandymanServiceWarrantyExpire` | POST `/handyman/service-warranties/{warrantyId}/expire` | perm+, err+, data |
| `postHandymanServiceWarrantyReworkPropose` | POST `/handyman/service-warranty-claims/{claimId}/reworks` | err+, data |
| `postHandymanServiceWarrantyReworkStart` | POST `/handyman/service-warranty-reworks/{reworkId}/start` | err+, data |
| `postHandymanServiceWarrantyReworkComplete` | POST `/handyman/service-warranty-reworks/{reworkId}/complete` | err+, data |
| `postHandymanServiceWarrantyReworkVerify` | POST `/handyman/service-warranty-reworks/{reworkId}/verify` | err+, data |
| `listStandaloneCareBuildings` | GET `/handyman/care/buildings` | perm+, err+ |
| `listStandaloneCareRequests` | GET `/handyman/care/buildings/{buildingId}/requests` | perm+, err+, other |
| `createBuildingCareRequest` | POST `/handyman/care/buildings/{buildingId}/requests` | perm+, err+ |
| `getStandaloneCareRequestDetail` | GET `/handyman/care/buildings/{buildingId}/requests/{requestId}` | perm+, err+ |
| `cancelBuildingCareRequest` | POST `/handyman/care/buildings/{buildingId}/requests/{requestId}/cancel` | perm+, err+ |
| `getStandaloneCareRequestProgress` | GET `/handyman/care/buildings/{buildingId}/requests/{requestId}/progress` | perm+, err+ |
| `listBuildingCareTenants` | GET `/handyman/care/buildings/{buildingId}/tenants` | perm+, err+ |
| `listBuildingCareFloors` | GET `/handyman/care/buildings/{buildingId}/floors` | perm+, err+ |
| `listBuildingCareUnits` | GET `/handyman/care/buildings/{buildingId}/units` | perm+, err+ |
| `listBuildingCareCatalogueServices` | GET `/handyman/care/buildings/{buildingId}/catalogue/services` | perm+, err+ |
| `listBuildingCareRequestIntakeEvidence` | GET `/handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` | perm+, err+ |
| `uploadBuildingCareRequestIntakeEvidence` | POST `/handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` | perm+, err+ |
| `careCatalogueServices` | GET `/handyman/care/properties/{propertyId}/catalogue/services` | err+ |
| `careCatalogueProfiles` | GET `/handyman/care/properties/{propertyId}/catalogue/material-profiles` | err+ |
| `careCatalogueDetail` | GET `/handyman/care/properties/{propertyId}/catalogue/material-profiles/{profileId}` | err+ |
| `listCareWorkspacePropertys` | GET `/handyman/care/properties` | err+ |
| `listCareWorkspaceBuildings` | GET `/handyman/care/properties/{propertyId}/buildings` | err+ |
| `listCareWorkspaceTenants` | GET `/handyman/care/properties/{propertyId}/tenant-companies` | err+ |
| `listCareWorkspaceSpaces` | GET `/handyman/care/properties/{propertyId}/spaces` | err+ |
| `getCareWorkspaceRequestDetail` | GET `/handyman/care/requests/{requestId}` | err+ |
| `getCareWorkspaceOperationalProjection` | GET `/handyman/care/requests/{requestId}/projection` | err+ |
| `uploadCareHandymanCustomerPaymentProof` | POST `/handyman/care/requests/{requestId}/invoices/{invoiceId}/payments/{paymentId}/proof` | err+ |
| `listCareWorkspaceRequests` | GET `/handyman/care/requests` | err+, other |
| `issueCareCreateExchange` | POST `/handyman/care/properties/{propertyId}/create-exchanges` | err+ |
| `listCareWorkspaceOccupancies` | GET `/handyman/care/properties/{propertyId}/occupancies` | err+ |
| `admitCareWorkspace` | POST `/handyman/care/session` | err+ |
| `revokeCareWorkspaceSession` | DELETE `/handyman/care/session` | err+ |
| `listHandymanCatalogueServices` | GET `/handyman/catalogue/services` | perm+, err+ |
| `listHandymanCatalogueMaterialProfiles` | GET `/handyman/catalogue/material-profiles` | perm+, err+ |
| `describeHandymanCatalogueMaterialProfile` | GET `/handyman/catalogue/material-profiles/{profileId}` | perm+, err+ |
| `listHandymanOperationsQueue` | GET `/handyman/operations/queue` | err+ |
| `listHandymanOperationsCommercialInbox` | GET `/handyman/operations/commercial-inbox` | err+ |
| `listHandymanServiceRequests` | GET `/handyman/requests` | perm+, err+ |
| `createHandymanServiceRequest` | POST `/handyman/requests` | perm+, err+ |
| `createCareHandymanServiceRequest` | POST `/handyman/requests/care` | err+ |
| `getHandymanServiceRequestDetail` | GET `/handyman/requests/{handymanRequestId}` | perm+, err+, desc |
| `listHandymanIntakeEvidence` | GET `/handyman/requests/{handymanRequestId}/intake-evidence` | perm+, err+ |
| `uploadHandymanIntakeEvidence` | POST `/handyman/requests/{handymanRequestId}/intake-evidence` | perm+, err+ |
| `recordHandymanRequestTriage` | POST `/handyman/requests/{handymanRequestId}/triage` | perm+, err+ |
| `getHandymanRequestTriage` | GET `/handyman/requests/{handymanRequestId}/triage` | perm+, err+ |
| `recordHandymanInspection` | POST `/handyman/requests/{handymanRequestId}/inspection` | perm+, err+ |
| `getHandymanRequestInspection` | GET `/handyman/requests/{handymanRequestId}/inspection` | perm+, err+ |
| `recordHandymanDiagnosis` | POST `/handyman/requests/{handymanRequestId}/diagnosis` | perm+, err+ |
| `getHandymanRequestDiagnosis` | GET `/handyman/requests/{handymanRequestId}/diagnosis` | perm+, err+ |
| `recordHandymanReferral` | POST `/handyman/requests/{handymanRequestId}/referral` | perm+, err+ |
| `getHandymanRequestReferral` | GET `/handyman/requests/{handymanRequestId}/referral` | perm+, err+ |
| `cancelHandymanRequest` | POST `/handyman/requests/{handymanRequestId}/cancel` | perm+, err+ |
| `getHandymanRequestCancellation` | GET `/handyman/requests/{handymanRequestId}/cancellation` | perm+, err+ |
| `listHandymanProviderAvailability` | GET `/handyman/provider-availability` | perm+, err+, desc |
| `createHandymanProviderContext` | POST `/handyman/provider-contexts` | perm+, err+ |
| `getHandymanProviderContextByVendor` | GET `/handyman/provider-contexts/by-vendor/{vendorId}` | perm+, err+ |
| `setHandymanProviderContextStatus` | POST `/handyman/provider-contexts/{providerContextId}/status` | perm+, err+ |
| `createHandymanWorkerContext` | POST `/handyman/worker-contexts` | perm+, err+ |
| `getHandymanWorkerContext` | GET `/handyman/worker-contexts/{workerContextId}` | perm+, err+ |
| `setHandymanWorkerContextStatus` | POST `/handyman/worker-contexts/{workerContextId}/status` | perm+, err+ |
| `createHandymanWorkCrew` | POST `/handyman/work-crews` | perm+, err+ |
| `getHandymanWorkCrew` | GET `/handyman/work-crews/{crewId}` | perm+, err+ |
| `setHandymanWorkCrewStatus` | POST `/handyman/work-crews/{crewId}/status` | perm+, err+ |
| `addHandymanCrewMember` | POST `/handyman/work-crews/{crewId}/members` | perm+, err+ |
| `designateHandymanCrewLead` | POST `/handyman/work-crews/{crewId}/lead` | perm+, err+ |
| `setHandymanCrewMemberStatus` | POST `/handyman/crew-memberships/{membershipId}/status` | perm+, err+ |
| `createHandymanSchedulingReadiness` | POST `/handyman/requests/{handymanRequestId}/scheduling-readiness` | perm+, err+ |
| `getHandymanSchedulingReadiness` | GET `/handyman/requests/{handymanRequestId}/scheduling-readiness` | perm+, err+ |
| `listHandymanSchedulingReadinessHistory` | GET `/handyman/requests/{handymanRequestId}/scheduling-readiness/history` | perm+, err+ |
| `supersedeHandymanSchedulingReadiness` | POST `/handyman/scheduling-readiness/{readinessId}/supersede` | perm+, err+ |
| `createHandymanUnitAccessReadiness` | POST `/handyman/requests/{handymanRequestId}/unit-access-readiness` | perm+, err+ |
| `getHandymanUnitAccessReadiness` | GET `/handyman/requests/{handymanRequestId}/unit-access-readiness` | perm+, err+ |
| `listHandymanUnitAccessReadinessHistory` | GET `/handyman/requests/{handymanRequestId}/unit-access-readiness/history` | perm+, err+ |
| `supersedeHandymanUnitAccessReadiness` | POST `/handyman/unit-access-readiness/{readinessId}/supersede` | perm+, err+ |
| `createHandymanPermitReadiness` | POST `/handyman/requests/{handymanRequestId}/permit-readiness` | perm+, err+ |
| `getHandymanPermitReadiness` | GET `/handyman/requests/{handymanRequestId}/permit-readiness` | perm+, err+ |
| `listHandymanPermitReadinessHistory` | GET `/handyman/requests/{handymanRequestId}/permit-readiness/history` | perm+, err+ |
| `supersedeHandymanPermitReadiness` | POST `/handyman/permit-readiness/{readinessId}/supersede` | perm+, err+ |
| `createHandymanQuotation` | POST `/handyman/requests/{handymanRequestId}/quotation` | perm+, err+, sec+ |
| `getHandymanQuotation` | GET `/handyman/requests/{handymanRequestId}/quotation` | perm+, err+, sec+ |
| `getCurrentHandymanIssuedQuotationVersion` | GET `/handyman/requests/{handymanRequestId}/quotation/presented` | perm+, err+, sec+ |
| `createHandymanQuotationRevision` | POST `/handyman/quotations/{quotationId}/versions` | perm+, err+, sec+ |
| `addHandymanQuotationLine` | POST `/handyman/quotation-versions/{quotationVersionId}/lines` | perm+, err+, sec+ |
| `listHandymanQuotationVersionLines` | GET `/handyman/quotation-versions/{quotationVersionId}/lines` | perm+, err+, sec+ |
| `getHandymanQuotationVersionTotals` | GET `/handyman/quotation-versions/{quotationVersionId}/totals` | perm+, err+, sec+ |
| `issueHandymanQuotationVersion` | POST `/handyman/quotation-versions/{quotationVersionId}/issue` | perm+, err+, sec+ |
| `expireHandymanQuotationVersion` | POST `/handyman/quotation-versions/{quotationVersionId}/expire` | perm+, err+, sec+ |
| `supersedeHandymanQuotationVersion` | POST `/handyman/quotation-versions/{quotationVersionId}/supersede` | perm+, err+, sec+ |
| `decideHandymanQuotation` | POST `/handyman/quotation-versions/{quotationVersionId}/decision` | perm+, err+, sec+, desc |
| `getHandymanQuotationDecision` | GET `/handyman/quotation-versions/{quotationVersionId}/decision` | perm+, err+, sec+ |
| `getHandymanExecutionScopeByQuotationVersion` | GET `/handyman/quotation-versions/{quotationVersionId}/execution-scope` | perm+, err+, sec+ |
| `assignHandymanExecutionScopeCrew` | POST `/handyman/execution-scopes/{executionScopeId}/assignment` | perm+, err+, sec+ |
| `getHandymanExecutionScopeAssignment` | GET `/handyman/execution-scopes/{executionScopeId}/assignment` | perm+, err+, sec+ |
| `reassignHandymanExecutionScopeCrew` | POST `/handyman/execution-scopes/{executionScopeId}/assignment/reassign` | perm+, err+, sec+ |
| `getHandymanArrivalVerificationByScope` | GET `/handyman/execution-scopes/{executionScopeId}/arrival-verification` | perm+, err+, sec+, desc |
| `verifyHandymanArrival` | POST `/handyman/execution-scopes/{executionScopeId}/arrival-verification` | err+, sec+ |
| `listHandymanWorkSessionsByScope` | GET `/handyman/execution-scopes/{executionScopeId}/work-sessions` | perm+, err+, sec+, desc |
| `checkInHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/check-in` | err+, sec+ |
| `startWorkHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/start-work` | err+, sec+ |
| `pauseHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/pause` | err+, sec+ |
| `materialRunHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/material-run` | err+, sec+ |
| `resumeHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/resume` | err+, sec+ |
| `completeHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/complete` | err+, sec+ |
| `checkOutHandymanWorkSession` | POST `/handyman/execution-scopes/{executionScopeId}/work-sessions/check-out` | err+, sec+ |
| `getActiveHandymanWorkSession` | GET `/handyman/execution-scopes/{executionScopeId}/work-sessions/active` | err+, sec+ |
| `getHandymanWorkSessionTimeProjection` | GET `/handyman/work-sessions/{sessionId}/time-projection` | err+, sec+ |
| `listHandymanMaterialLinesByScope` | GET `/handyman/execution-scopes/{executionScopeId}/material-lines` | perm+, err+, sec+ |
| `estimateHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/estimate` | err+, sec+ |
| `getHandymanMaterialFinalChargeReadyProjection` | GET `/handyman/execution-scopes/{executionScopeId}/material-lines/final-charge-ready` | err+, sec+ |
| `approveHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/approve` | err+, sec+ |
| `issueHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/issue` | err+, sec+ |
| `purchaseHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/purchase` | err+, sec+ |
| `useHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/use` | err+, sec+ |
| `returnHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/return` | err+, sec+ |
| `settleHandymanMaterialExecutionLine` | POST `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/settle` | err+, sec+ |
| `createHandymanEvidenceRecord` | POST `/handyman/execution-scopes/{executionScopeId}/evidence` | err+, sec+ |
| `listHandymanEvidenceRecordsByScope` | GET `/handyman/execution-scopes/{executionScopeId}/evidence` | perm+, err+, sec+, desc |
| `addHandymanEvidenceFile` | POST `/handyman/evidence-records/{evidenceRecordId}/files` | err+, sec+ |
| `finalizeHandymanEvidenceRecord` | POST `/handyman/evidence-records/{evidenceRecordId}/finalize` | err+, sec+ |
| `getHandymanEvidenceRecordDetail` | GET `/handyman/evidence-records/{evidenceRecordId}` | perm+, err+, sec+, desc |
| `publishHandymanQcChecklistVersion` | POST `/handyman/clients/{clientId}/qc-checklist-versions` | err+, sec+ |
| `listHandymanQcChecklistVersions` | GET `/handyman/clients/{clientId}/qc-checklist-versions` | err+, sec+ |
| `bindHandymanQcChecklistVersion` | POST `/handyman/execution-scopes/{executionScopeId}/qc-checklist` | err+, sec+ |
| `getHandymanQcChecklistBinding` | GET `/handyman/execution-scopes/{executionScopeId}/qc-checklist` | err+, sec+, desc |
| `openHandymanQcRun` | POST `/handyman/execution-scopes/{executionScopeId}/qc-runs` | err+, sec+ |
| `listHandymanQcRunsByScope` | GET `/handyman/execution-scopes/{executionScopeId}/qc-runs` | err+, sec+ |
| `setHandymanQcRunItemOutcome` | POST `/handyman/qc-runs/{qcRunId}/items` | err+, sec+ |
| `bindHandymanQcRunEvidence` | POST `/handyman/qc-runs/{qcRunId}/evidence` | err+, sec+ |
| `finishHandymanQcRun` | POST `/handyman/qc-runs/{qcRunId}/finish` | err+, sec+ |
| `getHandymanQcRunDetail` | GET `/handyman/qc-runs/{qcRunId}` | err+, sec+ |
| `openHandymanDefect` | POST `/handyman/execution-scopes/{executionScopeId}/defects` | err+, sec+ |
| `listHandymanDefectsByScope` | GET `/handyman/execution-scopes/{executionScopeId}/defects` | err+, sec+, desc |
| `startHandymanDefectRectification` | POST `/handyman/defects/{defectId}/start-rectification` | err+, sec+ |
| `recordHandymanDefectRectification` | POST `/handyman/defects/{defectId}/record-rectification` | err+, sec+ |
| `requestHandymanDefectReinspection` | POST `/handyman/defects/{defectId}/request-reinspection` | err+, sec+ |
| `passHandymanDefectReinspection` | POST `/handyman/defects/{defectId}/pass-reinspection` | err+, sec+ |
| `getHandymanDefectDetail` | GET `/handyman/defects/{defectId}` | err+, sec+ |
| `getHandymanExecutionScopeBast` | GET `/handyman/execution-scopes/{executionScopeId}/bast` | perm+, err+, sec+, desc |
| `getHandymanBastById` | GET `/handyman/bast/{bastId}` | perm+, err+, sec+, desc |
| `acceptHandymanBast` | POST `/handyman/bast/{bastId}/accept` | perm+, err+, sec+, desc |
| `rejectHandymanBast` | POST `/handyman/bast/{bastId}/reject` | perm+, err+, sec+, desc |
| `signOffHandymanBast` | POST `/handyman/bast/{bastId}/sign-off` | perm+, err+, sec+, desc |
| `getHandymanWorkerExecutionScopeBast` | GET `/handyman/field/execution-scopes/{executionScopeId}/bast` | err+, sec+ |
| `prepareHandymanBastWorker` | POST `/handyman/field/execution-scopes/{executionScopeId}/bast/prepare` | perm+, err+, sec+ |
| `issueHandymanBastWorker` | POST `/handyman/field/bast/{bastId}/issue` | perm+, err+, sec+ |
| `voidHandymanBastWorker` | POST `/handyman/field/bast/{bastId}/void` | perm+, err+, sec+ |
| `getHandymanExecutionScopeCustomerLedger` | GET `/handyman/execution-scopes/{executionScopeId}/customer-ledger` | perm+, err+, sec+, desc |
| `getHandymanClientCustomerLedger` | GET `/handyman/customer-ledger` | perm+, err+, sec+ |
| `getHandymanExecutionScopeFinancialLedger` | GET `/handyman/execution-scopes/{executionScopeId}/financial-ledger` | err+ |
| `listHandymanExecutionScopeCustomerPayments` | GET `/handyman/execution-scopes/{executionScopeId}/customer-payments` | perm+, err+, sec+, desc |
| `recordHandymanCustomerPayment` | POST `/handyman/execution-scopes/{executionScopeId}/customer-payments` | perm+, err+, sec+, desc |
| `confirmHandymanCustomerPayment` | POST `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/confirm` | perm+, err+, sec+, desc |
| `rejectHandymanCustomerPayment` | POST `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/reject` | perm+, err+, sec+, desc |
| `getHandymanCustomerPaymentProof` | GET `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof` | err+ |
| `uploadHandymanCustomerPaymentProof` | POST `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof` | err~ |
| `getHandymanCustomerPaymentProofContent` | GET `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof/content` | err+ |
| `getHandymanExecutionScopeServiceWarranty` | GET `/handyman/execution-scopes/{executionScopeId}/service-warranty` | perm+, err+, sec+, desc |
| `getHandymanServiceWarrantyById` | GET `/handyman/service-warranties/{warrantyId}` | perm+, err+, sec+, desc |
| `openHandymanServiceWarrantyClaim` | POST `/handyman/service-warranties/{warrantyId}/claims` | perm+, err+, sec+, desc |
| `getHandymanServiceWarrantyClaimById` | GET `/handyman/service-warranty-claims/{claimId}` | perm+, err+, sec+, desc |
| `submitHandymanServiceWarrantyClaim` | POST `/handyman/service-warranty-claims/{claimId}/submit` | perm+, err+, sec+, desc |
| `approveHandymanServiceWarrantyClaim` | POST `/handyman/service-warranty-claims/{claimId}/approve` | perm+, err+, sec+, desc |
| `rejectHandymanServiceWarrantyClaim` | POST `/handyman/service-warranty-claims/{claimId}/reject` | perm+, err+, sec+, desc |
| `withdrawHandymanServiceWarrantyClaim` | POST `/handyman/service-warranty-claims/{claimId}/withdraw` | perm+, err+, sec+, desc |
| `getHandymanServiceWarrantyReworkById` | GET `/handyman/service-warranty-reworks/{reworkId}` | perm+, err+, sec+, desc |
| `authorizeHandymanServiceWarrantyRework` | POST `/handyman/service-warranty-reworks/{reworkId}/authorize` | perm+, err+, sec+, desc |
| `getHandymanChargeableAdditionalWorkById` | GET `/handyman/chargeable-additional-works/{workId}` | perm+, err+, sec+, desc |
| `acceptHandymanChargeableAdditionalWork` | POST `/handyman/chargeable-additional-works/{workId}/accept` | perm+, err+, sec+, desc |
| `rejectHandymanChargeableAdditionalWork` | POST `/handyman/chargeable-additional-works/{workId}/reject` | perm+, err+, sec+, desc |
| `getHandymanSubjectSla` | GET `/handyman/sla/subjects/{subjectType}/{subjectId}` | perm+, err+, sec+, desc |
| `getHandymanProviderPerformance` | GET `/handyman/provider-performance` | perm+, err+, sec+, desc |
| `getHandymanRequestStatusVisibility` | GET `/handyman/requests/{id}/status-visibility` | perm+, err+, sec+, desc |
| `getHandymanExecutionScopeStatusVisibility` | GET `/handyman/execution-scopes/{id}/status-visibility` | perm+, err+, sec+, desc |
| `listBuildingCareRequestParties` | GET `/handyman/care/buildings/{buildingId}/requests/{requestId}/parties` | perm+, err+ |
| `getBuildingCareAuthority` | GET `/handyman/care/buildings/{buildingId}/authority` | err+ |
| `recordHandymanCareCommunication` | POST `/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` | err~ |
| `listHandymanCareCommunications` | GET `/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` | err~, desc |
| `reportBuildingCareRequestPayment` | POST `/handyman/care/buildings/{buildingId}/requests/{requestId}/payments` | err~ |
| `uploadBuildingCareRequestPaymentProof` | POST `/handyman/care/buildings/{buildingId}/requests/{requestId}/payments/{paymentId}/proof` | err~ |
| `uploadCareWorkspaceRequestPaymentProof` | POST `/handyman/care/requests/{requestId}/payments/{paymentId}/proof` | err~, sec~ |
| `getHandymanDispatchReadiness` | GET `/handyman/execution-scopes/{executionScopeId}/dispatch/readiness` | err+ |
| `releaseHandymanDispatch` | POST `/handyman/execution-scopes/{executionScopeId}/dispatch/release` | err~ |
| `getHandymanDispatchRelease` | GET `/handyman/execution-scopes/{executionScopeId}/dispatch/release` | err~ |
| `cancelHandymanDispatch` | POST `/handyman/execution-scopes/{executionScopeId}/dispatch/cancel` | err~ |
| `getHandymanCanonicalIdentity` | GET `/handyman/requests/{handymanRequestId}/canonical-identity` | err+ |
| `getHandymanInvoiceReconciliationSummary` | GET `/handyman/execution-scopes/{executionScopeId}/invoice-reconciliation` | err+ |
| `getHandymanFinalCloseReadiness` | GET `/handyman/execution-scopes/{executionScopeId}/final-close/readiness` | err+ |
| `executeHandymanManagerFinalClose` | POST `/handyman/execution-scopes/{executionScopeId}/final-close` | err~ |
| `listHandymanVisitProposals` | GET `/handyman/requests/{handymanRequestId}/visits` | err+ |
| `proposeHandymanVisitAppointment` | POST `/handyman/requests/{handymanRequestId}/visits` | err~ |
| `cancelHandymanVisitProposal` | POST `/handyman/requests/{handymanRequestId}/visits/{appointmentId}/cancel-proposal` | — |
| `confirmHandymanTenantSlotVisit` | POST `/handyman/requests/{handymanRequestId}/visits/{appointmentId}/confirm` | err~ |
| `acceptTenantSlotChoice` | POST `/handyman/integrations/tenant-slot-choices` | err~, sec~ |
| `listEligibleHandymanInspectors` | GET `/handyman/visit-appointments/{visitAppointmentId}/inspector/eligible` | err+ |
| `getHandymanInspectorAssignment` | GET `/handyman/visit-appointments/{visitAppointmentId}/inspector` | err~ |
| `assignHandymanInspector` | POST `/handyman/visit-appointments/{visitAppointmentId}/inspector` | err~ |
| `reassignHandymanInspector` | POST `/handyman/visit-appointments/{visitAppointmentId}/inspector/reassign` | err~ |
| `revokeHandymanInspectorAssignment` | POST `/handyman/visit-appointments/{visitAppointmentId}/inspector/revoke` | err~ |
| `listHandymanInspectorAssignmentHistory` | GET `/handyman/requests/{handymanRequestId}/inspector-assignments/history` | err+ |
| `listOperationsHandymanMaterialPurchases` | GET `/handyman/execution-scopes/{executionScopeId}/material-purchases` | perm+, err~ |
| `approveHandymanMaterialPurchase` | POST `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/approve` | perm+, err~ |
| `issueHandymanMaterialPurchaseOperations` | POST `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/issue` | err~ |
| `recordHandymanSupplierPurchaseOperations` | POST `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/purchase` | err~, desc |
| `returnHandymanMaterialPurchaseOperations` | POST `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/return` | err~, desc |
| `reconcileHandymanMaterialPurchase` | POST `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/reconcile` | perm+, err~ |
| `listFieldHandymanMaterialPurchases` | GET `/handyman/field/execution-scopes/{executionScopeId}/material-purchases` | err~ |
| `submitHandymanMaterialPurchaseRequest` | POST `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/requests` | err~ |
| `issueHandymanMaterialPurchaseField` | POST `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/issue` | err~ |
| `recordHandymanSupplierPurchaseField` | POST `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/purchase` | err~ |
| `recordHandymanMaterialPurchaseUsage` | POST `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/usage` | err~ |
| `returnHandymanMaterialPurchaseField` | POST `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/return` | err~ |
| `listOperationsHandymanVariations` | GET `/handyman/execution-scopes/{executionScopeId}/variations` | perm+, err~, desc |
| `reviewHandymanVariationOperations` | POST `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/operations-review` | perm+, err~, desc |
| `issueHandymanVariationRevisedQuotation` | POST `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/revised-quotation` | perm+, err~ |
| `recordHandymanVariationTenantDecision` | POST `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/tenant-decision` | err~, desc, sum |
| `authorizeHandymanVariationScope` | POST `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/authorize-scope` | perm+, err~, desc |
| `recordHandymanVariationQcOperations` | POST `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/qc` | err~, desc |
| `recordHandymanVariationFinalChargeEligibility` | POST `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/final-charge-eligibility` | perm+, err~, desc |
| `listFieldHandymanVariations` | GET `/handyman/field/execution-scopes/{executionScopeId}/variations` | err~ |
| `reportHandymanVariationFinding` | POST `/handyman/field/execution-scopes/{executionScopeId}/variations/findings` | err~, desc |
| `submitHandymanVariationProposal` | POST `/handyman/field/execution-scopes/{executionScopeId}/variations/proposals` | err~ |
| `proposeHandymanVariationFromFinding` | POST `/handyman/field/execution-scopes/{executionScopeId}/variations/{variationId}/propose` | err~ |
| `recordHandymanVariationExecution` | POST `/handyman/field/execution-scopes/{executionScopeId}/variations/{variationId}/execution` | err~ |
| `recordHandymanVariationQcField` | POST `/handyman/field/execution-scopes/{executionScopeId}/variations/{variationId}/qc` | err~ |
| `uploadHandymanFieldEvidence` | POST `/handyman/field/evidence/upload` | err~ |
| `uploadHandymanScopeFieldEvidence` | POST `/handyman/field/execution-scopes/{executionScopeId}/evidence/upload` | err~ |
| `uploadHandymanRequestFieldEvidence` | POST `/handyman/field/requests/{handymanRequestId}/evidence/upload` | err~ |
| `presignHandymanFieldEvidenceUpload` | POST `/handyman/field/evidence/presign` | err~ |
| `putHandymanFieldEvidenceBytes` | PUT `/handyman/field/evidence/{evidenceId}/bytes` | err~ |
| `confirmHandymanFieldEvidenceUpload` | POST `/handyman/field/evidence/{evidenceId}/confirm` | err~ |
| `getHandymanFieldEvidence` | GET `/handyman/field/evidence/{evidenceId}` | err~ |
| `getHandymanFieldEvidenceContent` | GET `/handyman/field/evidence/{evidenceId}/content` | err~ |
| `getMyHandymanFieldJobs` | GET `/handyman/field/my-jobs` | — |
| `getHandymanFieldWorkOrderDetail` | GET `/handyman/field/work-orders/{executionScopeId}` | err~ |
| `getHandymanFieldExecutionScopeDetail` | GET `/handyman/field/execution-scopes/{executionScopeId}` | err~ |
| `getHandymanFieldQuotationSnapshot` | GET `/handyman/field/execution-scopes/{executionScopeId}/quotation-snapshot` | err~ |
| `getHandymanFieldScopeMaterials` | GET `/handyman/field/execution-scopes/{executionScopeId}/materials` | err~ |
| `getHandymanFieldRequestDetail` | GET `/handyman/field/requests/{handymanRequestId}` | err~ |
| `getMyHandymanWorkerProfile` | GET `/handyman/field/me/profile` | err+ |
| `getHandymanWorkerProfile` | GET `/handyman/field/workers/{workerContextId}/profile` | err+ |

## 6. Files changed

- `docs/api/openapi.yaml` — all contract changes in §1 (line-patched; never reserialized).
- `docs/api/CR-HM-MASTER-IND-01_OPENAPI.yaml`, `docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` — superseded banners only.
- `src/modules/handyman-bast-api/handyman-bast-api.routes.ts`, `src/modules/handyman-customer-ledger-api/handyman-customer-ledger-api.routes.ts`, `src/modules/handyman-service-warranty-api/handyman-service-warranty-api.routes.ts`, `src/modules/handyman-sla-status-api/handyman-sla-status-api.routes.ts` — **comment-only** corrections of the same stale `canAccessClient` claims fixed in the spec (they now state the BE-02G exact-Building walls the services already enforce). Zero executable change.
- `tests/handyman-contract-freeze-03-openapi.test.ts` — new durable guards (13 tests) binding the reconciled contract to runtime sources (status vocabulary const, live router census, seeded permissions, phantom absence, annotation policy, projection closure).
- `docs/contract-freeze/*` — this changelog; freeze candidate re-issued as v1.2; gap register amended (FG-02 CLOSED, FG-10 added); the three consumer handoffs re-issued for v1.2.

No production migration, no deployment, no merge is performed by this CR. It stops at an open pull request against `main` for review.
