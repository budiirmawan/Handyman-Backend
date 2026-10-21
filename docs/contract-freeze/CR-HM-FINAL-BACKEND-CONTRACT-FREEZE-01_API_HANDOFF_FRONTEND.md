# API Handoff — Frontend (Customer Care / Tenant-PIC Web) · Freeze Candidate v1.0

**Contract**: CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 v1.0 · **Backend baseline**: `main@8b80f92` (PR #48/#50 merged) · **Spec**: `docs/api/openapi.yaml` (1432 paths/1918 ops) · **Status: CANDIDATE, not final freeze** (see gap register FG-01/FG-03/FG-04).
Detailed payloads for cancellation/dispute: `docs/api/CR-HM-18_FRONTEND_HANDOFF.md`. This handoff governs where the two differ.

## 1. Authentication & identity

- `POST /api/v1/auth/login {email,password}` → opaque `sessionToken`; send `Authorization: Bearer <token>` on every call. 401 = no/invalid session; session TTL 480 min default.
- There is **no direct Tenant login**. Tenant/PIC decisions are bound through the Customer Care actor: Care acts with `handyman.care.building` + ACTIVE building assignment; Tenant/PIC identity on decisions is server-bound (request parties), never sent as client fields. Sending actor/status/client/building fields on Care routes → 400.
- Envelope `{success:true,data,meta?}` / `{success:false,error:{code,message,details?,requestId}}`. Render errors from `error.code` only.

## 2. Permissions for this lane

| Surface | Permission |
|---|---|
| Care workspace/discovery/requests | `handyman.care.building` (+ exact-Building assignment) |
| Staff request reads / cancellation read | `tenant_company.read` |
| Staff cancel, BAST accept/reject/sign-off, claim submit/withdraw | `tenant_company.manage` |
| Payment-proof upload (tenant-side fact) | Care/staff lane per route; proof never confirms a payment (Finance `handyman.finance.manage` does that) |

Cross-scope IDs return 404-shaped responses; inaccessible buildings 403 `BUILDING_ACCESS_DENIED`. Never enumerate.

## 3. State transitions you must render (server-authoritative; advance by command + re-read)

- Request: `INTAKE → TRIAGE → INSPECTION_REQUIRED → DIAGNOSIS → READY_FOR_NEXT_STEP`, terminal exits `REFERRED`, `CANCELLED` (pre-commitment only; 409 `HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED` once a quotation is approved).
- Visit: proposal → tenant-confirmed (not authoritative before confirmation).
- Quotation decision: bind to the exact presented version; APPROVE creates the execution scope.
- BAST: `DRAFT → ISSUED → ACCEPTED | REJECTED | VOID`; ACCEPT requires `signatureDigest` + same-scope `evidenceRecordId`.
- Warranty claim: open → submit → approve/reject; withdraw while open.
- `availableActions` on read payloads is a transport projection — render from it, but writes are always re-authorized (stale action → 403/409 is normal).

## 4. Errors (lane-critical)

400 `VALIDATION_ERROR` (strict allow-lists; unknown fields rejected on Care routes) · 401 unauthenticated · 403 `PERMISSION_DENIED`/`BUILDING_ACCESS_DENIED`/`HANDYMAN_CARE_AUTHORITY_DENIED` · 404 `HANDYMAN_SERVICE_REQUEST_NOT_FOUND` · 409 cancellation family (`ALREADY_CANCELLED`, `CANCELLATION_KEY_CONFLICT`, `CANCEL_NOT_ALLOWED`, `CANCEL_COMMITTED`) — full table in CR-HM-18 Frontend handoff §2.4. Idempotent replay (`replayed:true`, same `id`) is success, never an error toast.

## 5. Endpoint table (this lane; generated from the runtime route census)

`route-only` = registered and live, not yet in `openapi.yaml` (FG-01); its exact contract is the route's validation module + this handoff. All other rows are in OpenAPI under the given `operationId`.

| Method | Path | operationId / OpenAPI status |
|---|---|---|
| GET | `/handyman/bast/{bastId}` | `getHandymanBastById` |
| POST | `/handyman/bast/{bastId}/accept` | `acceptHandymanBast` |
| POST | `/handyman/bast/{bastId}/reject` | `rejectHandymanBast` |
| POST | `/handyman/bast/{bastId}/sign-off` | `signOffHandymanBast` |
| GET | `/handyman/care/buildings` | `listStandaloneCareBuildings` |
| GET | `/handyman/care/buildings/{buildingId}/authority` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/care/buildings/{buildingId}/catalogue/services` | `listBuildingCareCatalogueServices` |
| GET | `/handyman/care/buildings/{buildingId}/floors` | `listBuildingCareFloors` |
| GET | `/handyman/care/buildings/{buildingId}/requests` | `listStandaloneCareRequests` |
| POST | `/handyman/care/buildings/{buildingId}/requests` | `createBuildingCareRequest` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}` | `getStandaloneCareRequestDetail` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/cancel` | `cancelBuildingCareRequest` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` | route-only — not yet in `openapi.yaml` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` | `listBuildingCareRequestIntakeEvidence` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` | `uploadBuildingCareRequestIntakeEvidence` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/parties` | `listBuildingCareRequestParties` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/payments` | route-only — not yet in `openapi.yaml` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/payments/{paymentId}/proof` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/progress` | `getStandaloneCareRequestProgress` |
| GET | `/handyman/care/buildings/{buildingId}/tenants` | `listBuildingCareTenants` |
| GET | `/handyman/care/buildings/{buildingId}/units` | `listBuildingCareUnits` |
| GET | `/handyman/care/properties` | `listCareWorkspacePropertys` |
| GET | `/handyman/care/properties/{propertyId}/buildings` | `listCareWorkspaceBuildings` |
| GET | `/handyman/care/properties/{propertyId}/catalogue/material-profiles` | `careCatalogueProfiles` |
| GET | `/handyman/care/properties/{propertyId}/catalogue/material-profiles/{profileId}` | `careCatalogueDetail` |
| GET | `/handyman/care/properties/{propertyId}/catalogue/services` | `careCatalogueServices` |
| POST | `/handyman/care/properties/{propertyId}/create-exchanges` | `issueCareCreateExchange` |
| GET | `/handyman/care/properties/{propertyId}/occupancies` | `listCareWorkspaceOccupancies` |
| GET | `/handyman/care/properties/{propertyId}/spaces` | `listCareWorkspaceSpaces` |
| GET | `/handyman/care/properties/{propertyId}/tenant-companies` | `listCareWorkspaceTenants` |
| GET | `/handyman/care/requests` | `listCareWorkspaceRequests` |
| GET | `/handyman/care/requests/{requestId}` | `getCareWorkspaceRequestDetail` |
| POST | `/handyman/care/requests/{requestId}/invoices/{invoiceId}/payments/{paymentId}/proof` | `uploadCareHandymanCustomerPaymentProof` |
| POST | `/handyman/care/requests/{requestId}/payments/{paymentId}/proof` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/care/requests/{requestId}/projection` | `getCareWorkspaceOperationalProjection` |
| DELETE | `/handyman/care/session` | `revokeCareWorkspaceSession` |
| POST | `/handyman/care/session` | `admitCareWorkspace` |
| POST | `/handyman/chargeable-additional-works/{workId}/accept` | `acceptHandymanChargeableAdditionalWork` |
| POST | `/handyman/chargeable-additional-works/{workId}/reject` | `rejectHandymanChargeableAdditionalWork` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof` | route-only — not yet in `openapi.yaml` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/tenant-decision` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/execution-scopes/{id}/status-visibility` | `getHandymanExecutionScopeStatusVisibility` |
| POST | `/handyman/integrations/tenant-slot-choices` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/quotation-versions/{quotationVersionId}/decision` | `getHandymanQuotationDecision` |
| POST | `/handyman/quotation-versions/{quotationVersionId}/decision` | `decideHandymanQuotation` |
| POST | `/handyman/requests/{handymanRequestId}/visits/{appointmentId}/confirm` | route-only — not yet in `openapi.yaml` |
| GET | `/handyman/requests/{id}/status-visibility` | `getHandymanRequestStatusVisibility` |
| POST | `/handyman/service-warranties/{warrantyId}/claims` | `openHandymanServiceWarrantyClaim` |
| POST | `/handyman/service-warranty-claims/{claimId}/submit` | `submitHandymanServiceWarrantyClaim` |
| POST | `/handyman/service-warranty-claims/{claimId}/withdraw` | `withdrawHandymanServiceWarrantyClaim` |
| GET | `/handyman/sla/subjects/{subjectType}/{subjectId}` | `getHandymanSubjectSla` |
