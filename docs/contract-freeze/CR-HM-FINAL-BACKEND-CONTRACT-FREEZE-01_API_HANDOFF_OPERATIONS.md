# API Handoff — Operations (BM Operations / Finance / Admin Console) · Freeze Candidate v1.2

**Contract**: CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 · **Version: Freeze Candidate v1.2** (CR-HM-BACKEND-CONTRACT-FREEZE-03; lineage v1.0 → v1.1/PR #51 → v1.2) · **Backend baseline**: `main@38e779f` (PR #51 merged) · **Spec**: `docs/api/openapi.yaml` SHA-256 `f2ffec3f0bc3e4aa5db74265caeb0738b530aee0c43ca9c4e299866831d70352` (1494 paths/1985 ops/**2256 schemas**; 269/269 Handyman ops documented **and** permission/error/security-annotated — FG-01+FG-02 CLOSED) · **Status: CANDIDATE, not final freeze** (FG-03/FG-04 still open).
Companions: `docs/api/CR-HM-18_OPERATIONS_HANDOFF.md`, `docs/api/CR-HM-MASTER-IND-01_OPENAPI.yaml` + `docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` (**historical snapshots — bannered superseded in freeze-03; integrate against `docs/api/openapi.yaml` only**), finance detail in `docs/handyman/CR-HM-FIN-DISCOVERY-02_OPERATIONS_HANDOFF.md` / `CR-HM-FIN-DOCUMENTS-01_OPERATIONS_HANDOFF.md`. Full freeze-03 change matrix: `CR-HM-BACKEND-CONTRACT-FREEZE-03_CHANGELOG.md`.

## 0. What changed in v1.2 (freeze-03) — action required

Wire behavior is **unchanged**; freeze-03 completed metadata and corrected prose. Operations-relevant deltas:

1. **Tenant decisions are NOT Operations commands.** Freeze-02 prose wrongly presented `recordHandymanVariationTenantDecision` as an Operations recording endpoint. Runtime law (unchanged since ship): it and `decideHandymanQuotation` are **PIC-personal** — the PIC-linked platform user's own session only; Operations receives 403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`. Remove any "record tenant decision" console action for variations/quotations; Operations retains review → revised-quotation → authorize-scope → final-charge (all service-enforced `tenant_company.manage`, now annotated).
2. **Permissions/errors are machine-readable for all 269 ops** (179 `x-required-permission`, 269 `x-error-codes`). Service-enforced permissions that v1.1 left only in prose are annotated now: QC checklist publish/list/bind (`handyman.qc.configure`), variation review/revised-quotation/authorize/final-charge (`tenant_company.manage`) + operations list (`tenant_company.read`), material approve/reconcile (`tenant_company.manage`) + operations list (`tenant_company.read`). The other 90 ops are composite-authority (Crew Lead/session/HMAC) — intentionally unannotated; follow their descriptions.
3. **Manager FINAL CLOSE needs BOTH guards**: `finding.close` AND `handyman.finance.read` (the annotation names the first; the description carries both).
4. **Finance results are fully typed**: commercial agreements/pricing/BM-fee, transactions/charge-lines/allocations/corrections, entitlement derivation, financial reads, and the six settlement literal results (`{unitId,state,replayed}`, `{id,outcome,cause,variance,replayed}`, `{id,kind,replayed}`) have closed schemas with exact enums. Money stays decimal strings. Settlement `cause` ∈ `NONE|INCLUSION_MISMATCH|LEDGER_BASIS_MISMATCH|FUNDING_SHORTFALL|OPEN_EXCEPTION`; correction `kind` ∈ `REVERSED|ADJUSTED`; dispute `kind` is `DISPUTED`.
5. **Request status enum includes `CANCELLED`** everywhere (queue/list/detail/visibility) — terminal, pre-commitment only. Exact-Building wording was corrected on ~30 reads/commands (Client-wide assignment never suffices where BE-02G applies).
6. **Tenant slot-choice is server-to-server HMAC**: `acceptTenantSlotChoice` now documents its `tenantSlotAssertionSignature` scheme (`x-handyman-tenant-slot-signature`). The signing secret must never reach browser code; no user session exists on this door.
7. **Error-code corrections to code against:** `HANDYMAN_VARIATION_ROLE_FORBIDDEN` (not the never-existing `…_FORBIDDEN`); BAST ACCEPT without `signatureDigest` → 409 `HANDYMAN_BAST_SIGNATURE_REQUIRED`; 15 finance/warranty ops refuse bad input with domain `*_VALIDATION` codes, not `VALIDATION_ERROR`.

## 1. Authentication

`POST /api/v1/auth/login {email,password}` → opaque Bearer `sessionToken` (TTL 480 min default). Envelope and error model as in the Frontend handoff §1. Every mutating command takes `idempotencyKey` (1–200); replay with same payload returns `replayed:true`; reassign-style commands also require `expectedVersion` + `reason`. Unknown body fields → 400 (strict allow-lists). Amounts are server-derived — send references only.

## 2. Permissions (verified from route-file `requirePermission(...)`)

| Domain | Read | Command |
|---|---|---|
| Requests/visits/inspector/assignment/dispatch/arrival/queue | `tenant_company.read` | `tenant_company.manage` |
| Master data: units/parties | `space.read`, `unit_party.read` | `space.manage`, `unit_party.manage` |
| Tenant batch import | `tenant_company.read` | `tenant_company.manage` |
| Catalogue administration | `service_catalog.read` | `service_catalog.manage` |
| QC | composite: exact-Building + (`tenant_company.read` **or** current assignment PIC/Lead **or** QC Supervisor) — see each read's description | `handyman.qc.manage` (commands; + ACTIVE supervisor reporting line, not a crew member), `handyman.qc.configure` (checklist publish/list/bind — service-enforced, annotated in freeze-03) |
| Commercial agreements / pricing / BM-fee | `handyman.finance.read` | `handyman.commercial.manage` |
| Ledger / payments / allocations / corrections | `handyman.finance.read` | `handyman.finance.manage` |
| Settlement ladder + dispute adjudication | `handyman.finance.read` | `handyman.settlement.manage` (**never** implied by finance/tenant permissions — 0448 split) |
| Manager FINAL CLOSE | `handyman.finance.read` (+ readiness) | `finding.close` |
| IAM / Client master | platform `user.read`, `role.read`, `permission.read` | `user.manage`, `role.manage`, `permission.manage`, `building.manage` |

Exact-Building assignment scoping everywhere; cross-Client → 404-shaped.

## 3. State transitions (server-authoritative)

Request `INTAKE→TRIAGE→INSPECTION_REQUIRED→DIAGNOSIS→READY_FOR_NEXT_STEP` (+`REFERRED`/`CANCELLED` terminals) · Quotation `DRAFT→ISSUED→APPROVED|REJECTED|EXPIRED|SUPERSEDED` (DP terms fixed at version) · Dispatch release `RELEASED→SUPERSEDED|CANCELLED` (reassignment supersedes) · QC run `OPEN→ITEM_SET→FINISHED(PASS|FAIL)`; defect `OPEN→RECTIFYING→RECTIFIED→VERIFIED` · BAST `DRAFT→ISSUED→ACCEPTED|REJECTED|VOID` (prepare requires CURRENT guarded QC PASS, 0445) · Payment recorded→`CONFIRMED|REJECTED`; allocations bounded by NET caps (0447) · Settlement `PREPARED→INCLUDED→RECONCILED(MATCHED|VARIANCE)→SETTLED`, dispute `DISPUTED→RELEASED|UPHELD` (one adjudication, append-only, 0460; settlement moves no funds) · Warranty `ACTIVE→CLAIM_OPEN→…→EXPIRED`; FINAL CLOSE only when readiness returns zero blockers (20 frozen blocker codes) → scope `CLOSED`.

**Finance note (FG-05):** payment `confirm` in this candidate validates authority/idempotency only — bank-receipt attestation (open PR #47) is *not* part of the candidate and must not be assumed by the console.

## 4. Master-data endpoints added to the main OpenAPI by this CR

`GET /buildings/{buildingId}/units`, `GET|PATCH /buildings/{buildingId}/units/{unitId}`, `GET …/units/{unitId}/occupancies`, `GET|POST …/units/{unitId}/parties`, `POST /unit-party-roles/{id}/end`, `GET /service-catalog/categories`, `GET|POST /service-catalog/entries/{serviceCatalogId}/variants`, `GET|POST …/material-profiles`, `GET /handyman/care/buildings/{buildingId}/requests/{requestId}/parties`, `POST|GET /clients/{clientId}/tenant-imports`, `GET …/tenant-imports/{batchId}`, `POST …/tenant-imports/{batchId}/validate|confirm|commit|abort`, `POST /tenant-companies/{id}/verification`, `POST /tenant-pics/{id}/verification`. Tenant-import lifecycle: upload → validate → confirm → commit (or abort); commit is the only step that writes Tenant/PIC masters.

## 5. Endpoint table (this lane; generated from the runtime route census)

Every row is in OpenAPI under the given `operationId` (the formerly route-only operations — dispatch, inspector assignments, visits/slot-confirm, material-purchases, variations, final-close — were documented by CR-HM-BACKEND-CONTRACT-FREEZE-02 with exact source-derived schemas; FG-01 CLOSED). Freeze-03 completed the metadata: single-permission authority is machine-readable via `x-required-permission` (179 ops, incl. 11 service-enforced); the remaining composite-authority ops (Crew Lead / workspace session / HMAC) state their rule in each description and deliberately carry no permission annotation. Every op declares `x-error-codes` and an explicit `security` decision.

| Method | Path | operationId / OpenAPI status |
|---|---|---|
| GET | `/handyman/bm-fee-configuration` | `getHandymanBmFeeConfiguration` |
| GET | `/handyman/catalogue/material-profiles` | `listHandymanCatalogueMaterialProfiles` |
| GET | `/handyman/catalogue/material-profiles/{profileId}` | `describeHandymanCatalogueMaterialProfile` |
| GET | `/handyman/catalogue/services` | `listHandymanCatalogueServices` |
| GET | `/handyman/chargeable-additional-works/{workId}` | `getHandymanChargeableAdditionalWorkById` |
| GET | `/handyman/clients/{clientId}/qc-checklist-versions` | `listHandymanQcChecklistVersions` |
| POST | `/handyman/clients/{clientId}/qc-checklist-versions` | `publishHandymanQcChecklistVersion` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/activate` | `postHandymanCommercialAgreementVersionActivate` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-beneficiary` | `postHandymanBmFeeBeneficiary` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-rule` | `postHandymanBmFeeRule` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/bm-fee-term` | `postHandymanBmFeeTerm` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/labor-pricing-basis` | `postHandymanLaborPricingBasis` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/material-pricing-basis` | `postHandymanMaterialPricingBasis` |
| POST | `/handyman/commercial-agreement-versions/{agreementVersionId}/supersede` | `postHandymanCommercialAgreementVersionSupersede` |
| POST | `/handyman/commercial-agreements` | `postHandymanCommercialAgreement` |
| POST | `/handyman/crew-memberships/{membershipId}/status` | `setHandymanCrewMemberStatus` |
| GET | `/handyman/customer-ledger` | `getHandymanClientCustomerLedger` |
| GET | `/handyman/defects/{defectId}` | `getHandymanDefectDetail` |
| POST | `/handyman/defects/{defectId}/pass-reinspection` | `passHandymanDefectReinspection` |
| POST | `/handyman/defects/{defectId}/record-rectification` | `recordHandymanDefectRectification` |
| POST | `/handyman/defects/{defectId}/request-reinspection` | `requestHandymanDefectReinspection` |
| POST | `/handyman/defects/{defectId}/start-rectification` | `startHandymanDefectRectification` |
| GET | `/handyman/evidence-records/{evidenceRecordId}` | `getHandymanEvidenceRecordDetail` |
| POST | `/handyman/evidence-records/{evidenceRecordId}/files` | `addHandymanEvidenceFile` |
| POST | `/handyman/evidence-records/{evidenceRecordId}/finalize` | `finalizeHandymanEvidenceRecord` |
| GET | `/handyman/execution-scopes/{executionScopeId}/arrival-verification` | `getHandymanArrivalVerificationByScope` |
| POST | `/handyman/execution-scopes/{executionScopeId}/arrival-verification` | `verifyHandymanArrival` |
| GET | `/handyman/execution-scopes/{executionScopeId}/assignment` | `getHandymanExecutionScopeAssignment` |
| POST | `/handyman/execution-scopes/{executionScopeId}/assignment` | `assignHandymanExecutionScopeCrew` |
| POST | `/handyman/execution-scopes/{executionScopeId}/assignment/reassign` | `reassignHandymanExecutionScopeCrew` |
| GET | `/handyman/execution-scopes/{executionScopeId}/bast` | `getHandymanExecutionScopeBast` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-charge-lines` | `postHandymanCustomerChargeLine` |
| GET | `/handyman/execution-scopes/{executionScopeId}/customer-ledger` | `getHandymanExecutionScopeCustomerLedger` |
| GET | `/handyman/execution-scopes/{executionScopeId}/customer-payments` | `listHandymanExecutionScopeCustomerPayments` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-payments` | `recordHandymanCustomerPayment` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/confirm` | `confirmHandymanCustomerPayment` |
| GET | `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof` | `getHandymanCustomerPaymentProof` |
| GET | `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof/content` | `getHandymanCustomerPaymentProofContent` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/reject` | `rejectHandymanCustomerPayment` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-transaction` | `postHandymanCustomerTransactionOpen` |
| GET | `/handyman/execution-scopes/{executionScopeId}/defects` | `listHandymanDefectsByScope` |
| POST | `/handyman/execution-scopes/{executionScopeId}/defects` | `openHandymanDefect` |
| POST | `/handyman/execution-scopes/{executionScopeId}/dispatch/cancel` | `cancelHandymanDispatch` |
| GET | `/handyman/execution-scopes/{executionScopeId}/dispatch/readiness` | `getHandymanDispatchReadiness` |
| GET | `/handyman/execution-scopes/{executionScopeId}/dispatch/release` | `getHandymanDispatchRelease` |
| POST | `/handyman/execution-scopes/{executionScopeId}/dispatch/release` | `releaseHandymanDispatch` |
| GET | `/handyman/execution-scopes/{executionScopeId}/evidence` | `listHandymanEvidenceRecordsByScope` |
| POST | `/handyman/execution-scopes/{executionScopeId}/evidence` | `createHandymanEvidenceRecord` |
| POST | `/handyman/execution-scopes/{executionScopeId}/final-close` | `executeHandymanManagerFinalClose` |
| GET | `/handyman/execution-scopes/{executionScopeId}/final-close/readiness` | `getHandymanFinalCloseReadiness` |
| POST | `/handyman/execution-scopes/{executionScopeId}/financial-entitlements/derive` | `postHandymanFinancialEntitlementsDerive` |
| GET | `/handyman/execution-scopes/{executionScopeId}/financial-ledger` | `getHandymanExecutionScopeFinancialLedger` |
| GET | `/handyman/execution-scopes/{executionScopeId}/financial-transaction` | `getHandymanFinancialTransaction` |
| GET | `/handyman/execution-scopes/{executionScopeId}/invoice-reconciliation` | `getHandymanInvoiceReconciliationSummary` |
| POST | `/handyman/execution-scopes/{executionScopeId}/ledger-adjustments` | `postHandymanLedgerAdjustment` |
| POST | `/handyman/execution-scopes/{executionScopeId}/ledger-refunds` | `postHandymanLedgerRefund` |
| POST | `/handyman/execution-scopes/{executionScopeId}/ledger-reversals/allocation` | `postHandymanLedgerAllocationReversal` |
| POST | `/handyman/execution-scopes/{executionScopeId}/ledger-reversals/payment` | `postHandymanLedgerPaymentReversal` |
| GET | `/handyman/execution-scopes/{executionScopeId}/material-lines` | `listHandymanMaterialLinesByScope` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/approve` | `approveHandymanMaterialExecutionLine` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/issue` | `issueHandymanMaterialExecutionLine` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/purchase` | `purchaseHandymanMaterialExecutionLine` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/return` | `returnHandymanMaterialExecutionLine` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/settle` | `settleHandymanMaterialExecutionLine` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/use` | `useHandymanMaterialExecutionLine` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-lines/estimate` | `estimateHandymanMaterialExecutionLine` |
| GET | `/handyman/execution-scopes/{executionScopeId}/material-lines/final-charge-ready` | `getHandymanMaterialFinalChargeReadyProjection` |
| GET | `/handyman/execution-scopes/{executionScopeId}/material-purchases` | `listOperationsHandymanMaterialPurchases` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/approve` | `approveHandymanMaterialPurchase` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/issue` | `issueHandymanMaterialPurchaseOperations` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/purchase` | `recordHandymanSupplierPurchaseOperations` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/reconcile` | `reconcileHandymanMaterialPurchase` |
| POST | `/handyman/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/return` | `returnHandymanMaterialPurchaseOperations` |
| POST | `/handyman/execution-scopes/{executionScopeId}/payment-allocations` | `postHandymanPaymentAllocation` |
| GET | `/handyman/execution-scopes/{executionScopeId}/qc-checklist` | `getHandymanQcChecklistBinding` |
| POST | `/handyman/execution-scopes/{executionScopeId}/qc-checklist` | `bindHandymanQcChecklistVersion` |
| GET | `/handyman/execution-scopes/{executionScopeId}/qc-runs` | `listHandymanQcRunsByScope` |
| POST | `/handyman/execution-scopes/{executionScopeId}/qc-runs` | `openHandymanQcRun` |
| GET | `/handyman/execution-scopes/{executionScopeId}/service-warranty` | `getHandymanExecutionScopeServiceWarranty` |
| POST | `/handyman/execution-scopes/{executionScopeId}/service-warranty/start` | `postHandymanServiceWarrantyStart` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/correction` | `postHandymanSettlementCorrection` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/dispute` | `postHandymanSettlementDispute` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/dispute/resolution` | `postHandymanSettlementDisputeResolution` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/include` | `postHandymanSettlementInclude` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/prepare` | `postHandymanSettlementPrepare` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/reconcile` | `postHandymanSettlementReconcile` |
| POST | `/handyman/execution-scopes/{executionScopeId}/settlement/settle` | `postHandymanSettlementSettle` |
| GET | `/handyman/execution-scopes/{executionScopeId}/variations` | `listOperationsHandymanVariations` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/authorize-scope` | `authorizeHandymanVariationScope` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/final-charge-eligibility` | `recordHandymanVariationFinalChargeEligibility` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/operations-review` | `reviewHandymanVariationOperations` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/qc` | `recordHandymanVariationQcOperations` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/revised-quotation` | `issueHandymanVariationRevisedQuotation` |
| GET | `/handyman/finance/action-inbox` | `listHandymanFinanceActionInbox` |
| GET | `/handyman/financial-transactions` | `getHandymanFinancialTransactions` |
| GET | `/handyman/operations/commercial-inbox` | `listHandymanOperationsCommercialInbox` |
| GET | `/handyman/operations/queue` | `listHandymanOperationsQueue` |
| POST | `/handyman/permit-readiness/{readinessId}/supersede` | `supersedeHandymanPermitReadiness` |
| GET | `/handyman/pricing-contract` | `getHandymanPricingContract` |
| GET | `/handyman/provider-availability` | `listHandymanProviderAvailability` |
| POST | `/handyman/provider-contexts` | `createHandymanProviderContext` |
| POST | `/handyman/provider-contexts/{providerContextId}/status` | `setHandymanProviderContextStatus` |
| GET | `/handyman/provider-contexts/by-vendor/{vendorId}` | `getHandymanProviderContextByVendor` |
| GET | `/handyman/provider-performance` | `getHandymanProviderPerformance` |
| GET | `/handyman/qc-runs/{qcRunId}` | `getHandymanQcRunDetail` |
| POST | `/handyman/qc-runs/{qcRunId}/evidence` | `bindHandymanQcRunEvidence` |
| POST | `/handyman/qc-runs/{qcRunId}/finish` | `finishHandymanQcRun` |
| POST | `/handyman/qc-runs/{qcRunId}/items` | `setHandymanQcRunItemOutcome` |
| GET | `/handyman/quotation-versions/{quotationVersionId}/execution-scope` | `getHandymanExecutionScopeByQuotationVersion` |
| POST | `/handyman/quotation-versions/{quotationVersionId}/expire` | `expireHandymanQuotationVersion` |
| POST | `/handyman/quotation-versions/{quotationVersionId}/issue` | `issueHandymanQuotationVersion` |
| GET | `/handyman/quotation-versions/{quotationVersionId}/lines` | `listHandymanQuotationVersionLines` |
| POST | `/handyman/quotation-versions/{quotationVersionId}/lines` | `addHandymanQuotationLine` |
| POST | `/handyman/quotation-versions/{quotationVersionId}/supersede` | `supersedeHandymanQuotationVersion` |
| GET | `/handyman/quotation-versions/{quotationVersionId}/totals` | `getHandymanQuotationVersionTotals` |
| POST | `/handyman/quotations/{quotationId}/versions` | `createHandymanQuotationRevision` |
| GET | `/handyman/requests` | `listHandymanServiceRequests` |
| POST | `/handyman/requests` | `createHandymanServiceRequest` |
| GET | `/handyman/requests/{handymanRequestId}` | `getHandymanServiceRequestDetail` |
| POST | `/handyman/requests/{handymanRequestId}/cancel` | `cancelHandymanRequest` |
| GET | `/handyman/requests/{handymanRequestId}/cancellation` | `getHandymanRequestCancellation` |
| GET | `/handyman/requests/{handymanRequestId}/canonical-identity` | `getHandymanCanonicalIdentity` |
| GET | `/handyman/requests/{handymanRequestId}/diagnosis` | `getHandymanRequestDiagnosis` |
| POST | `/handyman/requests/{handymanRequestId}/diagnosis` | `recordHandymanDiagnosis` |
| GET | `/handyman/requests/{handymanRequestId}/inspection` | `getHandymanRequestInspection` |
| POST | `/handyman/requests/{handymanRequestId}/inspection` | `recordHandymanInspection` |
| GET | `/handyman/requests/{handymanRequestId}/inspector-assignments/history` | `listHandymanInspectorAssignmentHistory` |
| GET | `/handyman/requests/{handymanRequestId}/intake-evidence` | `listHandymanIntakeEvidence` |
| POST | `/handyman/requests/{handymanRequestId}/intake-evidence` | `uploadHandymanIntakeEvidence` |
| GET | `/handyman/requests/{handymanRequestId}/permit-readiness` | `getHandymanPermitReadiness` |
| POST | `/handyman/requests/{handymanRequestId}/permit-readiness` | `createHandymanPermitReadiness` |
| GET | `/handyman/requests/{handymanRequestId}/permit-readiness/history` | `listHandymanPermitReadinessHistory` |
| GET | `/handyman/requests/{handymanRequestId}/quotation` | `getHandymanQuotation` |
| POST | `/handyman/requests/{handymanRequestId}/quotation` | `createHandymanQuotation` |
| GET | `/handyman/requests/{handymanRequestId}/quotation/presented` | `getCurrentHandymanIssuedQuotationVersion` |
| GET | `/handyman/requests/{handymanRequestId}/referral` | `getHandymanRequestReferral` |
| POST | `/handyman/requests/{handymanRequestId}/referral` | `recordHandymanReferral` |
| GET | `/handyman/requests/{handymanRequestId}/scheduling-readiness` | `getHandymanSchedulingReadiness` |
| POST | `/handyman/requests/{handymanRequestId}/scheduling-readiness` | `createHandymanSchedulingReadiness` |
| GET | `/handyman/requests/{handymanRequestId}/scheduling-readiness/history` | `listHandymanSchedulingReadinessHistory` |
| GET | `/handyman/requests/{handymanRequestId}/triage` | `getHandymanRequestTriage` |
| POST | `/handyman/requests/{handymanRequestId}/triage` | `recordHandymanRequestTriage` |
| GET | `/handyman/requests/{handymanRequestId}/unit-access-readiness` | `getHandymanUnitAccessReadiness` |
| POST | `/handyman/requests/{handymanRequestId}/unit-access-readiness` | `createHandymanUnitAccessReadiness` |
| GET | `/handyman/requests/{handymanRequestId}/unit-access-readiness/history` | `listHandymanUnitAccessReadinessHistory` |
| GET | `/handyman/requests/{handymanRequestId}/visits` | `listHandymanVisitProposals` |
| POST | `/handyman/requests/{handymanRequestId}/visits` | `proposeHandymanVisitAppointment` |
| POST | `/handyman/requests/{handymanRequestId}/visits/{appointmentId}/cancel-proposal` | `cancelHandymanVisitProposal` |
| POST | `/handyman/requests/care` | `createCareHandymanServiceRequest` |
| POST | `/handyman/scheduling-readiness/{readinessId}/supersede` | `supersedeHandymanSchedulingReadiness` |
| GET | `/handyman/service-warranties/{warrantyId}` | `getHandymanServiceWarrantyById` |
| POST | `/handyman/service-warranties/{warrantyId}/expire` | `postHandymanServiceWarrantyExpire` |
| GET | `/handyman/service-warranty-claims/{claimId}` | `getHandymanServiceWarrantyClaimById` |
| POST | `/handyman/service-warranty-claims/{claimId}/approve` | `approveHandymanServiceWarrantyClaim` |
| POST | `/handyman/service-warranty-claims/{claimId}/reject` | `rejectHandymanServiceWarrantyClaim` |
| POST | `/handyman/service-warranty-claims/{claimId}/reworks` | `postHandymanServiceWarrantyReworkPropose` |
| GET | `/handyman/service-warranty-reworks/{reworkId}` | `getHandymanServiceWarrantyReworkById` |
| POST | `/handyman/service-warranty-reworks/{reworkId}/authorize` | `authorizeHandymanServiceWarrantyRework` |
| POST | `/handyman/service-warranty-reworks/{reworkId}/verify` | `postHandymanServiceWarrantyReworkVerify` |
| POST | `/handyman/unit-access-readiness/{readinessId}/supersede` | `supersedeHandymanUnitAccessReadiness` |
| GET | `/handyman/visit-appointments/{visitAppointmentId}/inspector` | `getHandymanInspectorAssignment` |
| POST | `/handyman/visit-appointments/{visitAppointmentId}/inspector` | `assignHandymanInspector` |
| GET | `/handyman/visit-appointments/{visitAppointmentId}/inspector/eligible` | `listEligibleHandymanInspectors` |
| POST | `/handyman/visit-appointments/{visitAppointmentId}/inspector/reassign` | `reassignHandymanInspector` |
| POST | `/handyman/visit-appointments/{visitAppointmentId}/inspector/revoke` | `revokeHandymanInspectorAssignment` |
| POST | `/handyman/work-crews` | `createHandymanWorkCrew` |
| GET | `/handyman/work-crews/{crewId}` | `getHandymanWorkCrew` |
| POST | `/handyman/work-crews/{crewId}/lead` | `designateHandymanCrewLead` |
| POST | `/handyman/work-crews/{crewId}/members` | `addHandymanCrewMember` |
| POST | `/handyman/work-crews/{crewId}/status` | `setHandymanWorkCrewStatus` |
| POST | `/handyman/worker-contexts` | `createHandymanWorkerContext` |
| GET | `/handyman/worker-contexts/{workerContextId}` | `getHandymanWorkerContext` |
| POST | `/handyman/worker-contexts/{workerContextId}/status` | `setHandymanWorkerContextStatus` |
