# API Handoff — Operations (BM Operations / Finance / Admin Console) · Freeze Candidate v1.0

**Contract**: CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 v1.0 · **Backend baseline**: `main@8b80f92` (PR #48/#50 merged) · **Spec**: `docs/api/openapi.yaml` (1494 paths/1985 ops; 269/269 Handyman ops documented — FG-01 CLOSED by CR-HM-BACKEND-CONTRACT-FREEZE-02, PR #51) · **Status: CANDIDATE, not final freeze** (FG-03/FG-04 still open).
Companions: `docs/api/CR-HM-18_OPERATIONS_HANDOFF.md`, `docs/api/CR-HM-MASTER-IND-01_OPENAPI.yaml` + `docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` (provenance; their paths are now merged into the main spec), finance detail in `docs/handyman/CR-HM-FIN-DISCOVERY-02_OPERATIONS_HANDOFF.md` / `CR-HM-FIN-DOCUMENTS-01_OPERATIONS_HANDOFF.md`.

## 1. Authentication

`POST /api/v1/auth/login {email,password}` → opaque Bearer `sessionToken` (TTL 480 min default). Envelope and error model as in the Frontend handoff §1. Every mutating command takes `idempotencyKey` (1–200); replay with same payload returns `replayed:true`; reassign-style commands also require `expectedVersion` + `reason`. Unknown body fields → 400 (strict allow-lists). Amounts are server-derived — send references only.

## 2. Permissions (verified from route-file `requirePermission(...)`)

| Domain | Read | Command |
|---|---|---|
| Requests/visits/inspector/assignment/dispatch/arrival/queue | `tenant_company.read` | `tenant_company.manage` |
| Master data: units/parties | `space.read`, `unit_party.read` | `space.manage`, `unit_party.manage` |
| Tenant batch import | `tenant_company.read` | `tenant_company.manage` |
| Catalogue administration | `service_catalog.read` | `service_catalog.manage` |
| QC | `tenant_company.read` (reads) | `handyman.qc.manage` (commands; + ACTIVE supervisor reporting line, not a crew member), `handyman.qc.configure` (checklist publish/bind) |
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

Every row is in OpenAPI under the given `operationId` (the formerly route-only operations — dispatch, inspector assignments, visits/slot-confirm, material-purchases, variations, final-close — were documented by CR-HM-BACKEND-CONTRACT-FREEZE-02 with exact source-derived schemas; FG-01 CLOSED). Service-enforced permissions (field/operations lanes) are stated in each operation's description where no route-level `x-required-permission` exists.

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
