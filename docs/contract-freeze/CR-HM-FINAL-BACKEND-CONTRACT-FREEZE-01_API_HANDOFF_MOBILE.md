# API Handoff — Mobile (Worker Field App) · Freeze Candidate v1.0

**Contract**: CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 v1.0 · **Backend baseline**: `main@8b80f92` (PR #48/#50 merged) · **Spec**: `docs/api/openapi.yaml` (1494 paths/1985 ops; 269/269 Handyman ops documented — FG-01 CLOSED by CR-HM-BACKEND-CONTRACT-FREEZE-02, PR #51) · **Status: CANDIDATE, not final freeze** (FG-03/FG-04 still open).
Companions: `MOBILE_API_HANDOFF.md`, `docs/api/CR-HM-18_MOBILE_HANDOFF.md`, `docs/api/HANDYMAN_BACKEND_API_HANDOFF_MOBILE.md`.

## 1. Authentication

Same platform session: `POST /api/v1/auth/login {email,password}` → `Authorization: Bearer <sessionToken>`. **The field lane adds no RBAC permission**: every `/handyman/field/**` and work-session command is authentication-only, and the service enforces CURRENT Crew Lead / assigned-worker authority per scope. A reassigned (superseded) Lead's token must fail — do not cache authority client-side; re-read `GET /handyman/field/my-jobs` / scope assignment after any 403/409.

## 2. Field rules

- Work sessions: `check-in → start-work → (pause | material-run → resume) → complete → check-out`; read `…/work-sessions/active` and `GET /handyman/work-sessions/{sessionId}/time-projection` for timers (server-projected; never compute payable time client-side).
- Field evidence: presign/upload → `PUT …/evidence/{evidenceId}/bytes` → `POST …/confirm`; the server verifies sha256/size — a confirm with mismatched bytes fails. Evidence purpose and scope binding are server-checked (QC/BAST gates consume only byte-verified evidence).
- Worker BAST: `POST /handyman/field/execution-scopes/{id}/bast/prepare` only after a CURRENT Supervisor QC PASS exists (0445); `issue|void` on `/handyman/field/bast/{bastId}/…`; customer accept/reject is **not** a Mobile operation.
- Variations & materials (field): propose findings/proposals and record purchase/usage/return from the field table below; Operations approves/decides — the app must render pending states, not assume approval.
- Warranty rework: Lead starts/completes rework (`/handyman/service-warranty-reworks/{reworkId}/start|complete`); authorize/verify are Operations/customer-side.
- Every mutating call sends `idempotencyKey` (1–200, one per user intent; reuse on network retry). Unknown fields → 400. Offline retries must replay the identical body.

## 3. Errors

401 unauthenticated · 403 not the current Lead/assigned worker ( re-read jobs, do not retry blindly) · 404 scope/job not yours (404-shaped, never enumerates) · 409 state conflict (e.g. session already checked out, BAST before QC PASS, superseded assignment) · 400 validation (incl. evidence hash/size). Render from `error.code`.

## 4. Endpoint table (this lane; generated from the runtime route census)

Every row is in OpenAPI under the given `operationId` — including the 28 field-lane operations (evidence upload/presign/bytes/confirm/content, field feed, scope/request detail, field material-purchases and variations, worker profile) documented by CR-HM-BACKEND-CONTRACT-FREEZE-02 with exact source-derived schemas (FG-01 CLOSED). This lane is still integrated **last** in the sequence.

| Method | Path | operationId / OpenAPI status |
|---|---|---|
| GET | `/handyman/execution-scopes/{executionScopeId}/work-sessions` | `listHandymanWorkSessionsByScope` |
| GET | `/handyman/execution-scopes/{executionScopeId}/work-sessions/active` | `getActiveHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/check-in` | `checkInHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/check-out` | `checkOutHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/complete` | `completeHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/material-run` | `materialRunHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/pause` | `pauseHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/resume` | `resumeHandymanWorkSession` |
| POST | `/handyman/execution-scopes/{executionScopeId}/work-sessions/start-work` | `startWorkHandymanWorkSession` |
| POST | `/handyman/field/bast/{bastId}/issue` | `issueHandymanBastWorker` |
| POST | `/handyman/field/bast/{bastId}/void` | `voidHandymanBastWorker` |
| GET | `/handyman/field/evidence/{evidenceId}` | `getHandymanFieldEvidence` |
| PUT | `/handyman/field/evidence/{evidenceId}/bytes` | `putHandymanFieldEvidenceBytes` |
| POST | `/handyman/field/evidence/{evidenceId}/confirm` | `confirmHandymanFieldEvidenceUpload` |
| GET | `/handyman/field/evidence/{evidenceId}/content` | `getHandymanFieldEvidenceContent` |
| POST | `/handyman/field/evidence/presign` | `presignHandymanFieldEvidenceUpload` |
| POST | `/handyman/field/evidence/upload` | `uploadHandymanFieldEvidence` |
| GET | `/handyman/field/execution-scopes/{executionScopeId}` | `getHandymanFieldExecutionScopeDetail` |
| GET | `/handyman/field/execution-scopes/{executionScopeId}/bast` | `getHandymanWorkerExecutionScopeBast` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/bast/prepare` | `prepareHandymanBastWorker` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/evidence/upload` | `uploadHandymanScopeFieldEvidence` |
| GET | `/handyman/field/execution-scopes/{executionScopeId}/material-purchases` | `listFieldHandymanMaterialPurchases` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/issue` | `issueHandymanMaterialPurchaseField` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/purchase` | `recordHandymanSupplierPurchaseField` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/return` | `returnHandymanMaterialPurchaseField` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/{purchaseRecordId}/usage` | `recordHandymanMaterialPurchaseUsage` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/material-purchases/requests` | `submitHandymanMaterialPurchaseRequest` |
| GET | `/handyman/field/execution-scopes/{executionScopeId}/materials` | `getHandymanFieldScopeMaterials` |
| GET | `/handyman/field/execution-scopes/{executionScopeId}/quotation-snapshot` | `getHandymanFieldQuotationSnapshot` |
| GET | `/handyman/field/execution-scopes/{executionScopeId}/variations` | `listFieldHandymanVariations` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/variations/{variationId}/execution` | `recordHandymanVariationExecution` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/variations/{variationId}/propose` | `proposeHandymanVariationFromFinding` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/variations/{variationId}/qc` | `recordHandymanVariationQcField` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/variations/findings` | `reportHandymanVariationFinding` |
| POST | `/handyman/field/execution-scopes/{executionScopeId}/variations/proposals` | `submitHandymanVariationProposal` |
| GET | `/handyman/field/me/profile` | `getMyHandymanWorkerProfile` |
| GET | `/handyman/field/my-jobs` | `getMyHandymanFieldJobs` |
| GET | `/handyman/field/requests/{handymanRequestId}` | `getHandymanFieldRequestDetail` |
| POST | `/handyman/field/requests/{handymanRequestId}/evidence/upload` | `uploadHandymanRequestFieldEvidence` |
| GET | `/handyman/field/work-orders/{executionScopeId}` | `getHandymanFieldWorkOrderDetail` |
| GET | `/handyman/field/workers/{workerContextId}/profile` | `getHandymanWorkerProfile` |
| POST | `/handyman/service-warranty-reworks/{reworkId}/complete` | `postHandymanServiceWarrantyReworkComplete` |
| POST | `/handyman/service-warranty-reworks/{reworkId}/start` | `postHandymanServiceWarrantyReworkStart` |
| GET | `/handyman/work-sessions/{sessionId}/time-projection` | `getHandymanWorkSessionTimeProjection` |
