# API Handoff — Frontend (Customer Care / Tenant-PIC Web) · Freeze Candidate v1.2

**Contract**: CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01 · **Version: Freeze Candidate v1.2** (CR-HM-BACKEND-CONTRACT-FREEZE-03; lineage v1.0 freeze-01 → v1.1 freeze-02/PR #51 → v1.2 freeze-03) · **Backend baseline**: `main@38e779f` (PR #51 merged; PR #48/#50 long merged) · **Spec**: `docs/api/openapi.yaml` SHA-256 `f2ffec3f0bc3e4aa5db74265caeb0738b530aee0c43ca9c4e299866831d70352` (1494 paths/1985 ops/**2256 schemas**; 269/269 Handyman ops documented **and** permission/error/security-annotated — FG-01+FG-02 CLOSED) · **Status: CANDIDATE, not final freeze** (FG-03/FG-04 still open).
Detailed payloads for cancellation/dispute: `docs/api/CR-HM-18_FRONTEND_HANDOFF.md`. This handoff governs where the two differ. Full freeze-03 change matrix: `CR-HM-BACKEND-CONTRACT-FREEZE-03_CHANGELOG.md`.

## 0. What changed in v1.2 (freeze-03) — action required

Wire behavior is **unchanged** (regenerated clients stay compatible), but freeze-03 corrected descriptions that were wrong in v1.1 and completed the missing metadata. Read these before building:

1. **Request status enum now includes `CANCELLED`** (`HandymanServiceRequestStatus`; it reaches you already today from list/detail/projection/visibility payloads — render it as a terminal state). `listCareWorkspaceRequests?status=` accepts it too.
2. **Tenant decisions are PIC-personal — v1.1 prose was wrong for variations.** `decideHandymanQuotation` and `recordHandymanVariationTenantDecision` succeed **only** when the caller is the platform User linked to the request's immutable Tenant PIC (own session, `tenant_company.manage` + exact-Building). There is **no** Care/Operations "record the tenant's decision" call; any other actor gets 403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`. If your UX assumed staff-side recording, rework it: the PIC's own session must call (see §1).
3. **BAST sign-off stays staff-side, with a sharp edge:** `signatureDigest` is optional in the schema but **required by the service on ACCEPT** (409 `HANDYMAN_BAST_SIGNATURE_REQUIRED` when missing/blank/>512 chars); `evidenceRecordId` is optional but must belong to the same execution scope when sent. The recorded actor is the staff user; the customer signature is attested data — the response never claims the PIC personally signed.
4. **Exact-Building, not Client-wide:** roughly 30 Customer-Care reads/commands that v1.1 described as `canAccessClient` in fact require an assignment to the resource's **exact Building** (BE-02G). A Care account assigned to another Building of the same Client sees denied/empty results — provision assignments accordingly.
5. **Finance & projection payloads are now fully typed**: the 32 finance-close results (agreements/pricing/ledger/settlement/warranty) and the complete `CareHandymanOperationalProjection` tree (versions, appointments, evidence, QC, BAST, invoice/paymentStatus, warranty, timeline) have closed schemas with exact enums — regenerate types instead of hand-mirroring. Money/quantities are decimal **strings**; `invoiceDate`/`dueDate` are date strings.
6. **Errors/permissions are machine-readable everywhere now**: every Handyman operation has `x-error-codes`; 179 have `x-required-permission`. Note `HANDYMAN_VARIATION_ROLE_FORBIDDEN` is the real variation role code (v1.1 prose named a nonexistent `HANDYMAN_VARIATION_FORBIDDEN`), and Care-communications 404s are the generic `NOT_FOUND` by design.

## 1. Authentication & identity

- `POST /api/v1/auth/login {email,password}` → opaque `sessionToken`; send `Authorization: Bearer <token>` on every call. 401 = no/invalid session; session TTL 480 min default.
- There is **no direct Tenant login** and **no Care impersonation**: Customer Care creates/manages requests *on behalf of* represented Tenant/PIC parties (server-resolved), but never authenticates *as* them. Care acts with `handyman.care.building` + ACTIVE assignment to the exact Building; represented Tenant/PIC identity is server-bound (request parties), never sent as client fields. Sending actor/status/client/building fields on Care routes → 400.
- **Two decision endpoints are PIC-personal** and cannot be executed by Care at all: `decideHandymanQuotation` and `recordHandymanVariationTenantDecision` require the session of the platform User **linked to the request's Tenant PIC** (plus `tenant_company.manage` + exact-Building access). Care/Operations sessions receive 403 `HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`. Plan the tenant-facing flow accordingly — the PIC-linked user must sign in with their own platform credentials to decide.
- Staff-recorded customer-consent transports (BAST accept/reject/sign-off, warranty claim open/submit/withdraw, rework authorize, chargeable accept/reject, payment record) are different by design: the **staff user is the recorded actor**, the represented tenant is server-resolved, and signatures/consents are attested data. Never present them as the PIC's own authenticated act.
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
- BAST: `DRAFT → ISSUED → ACCEPTED | REJECTED | VOID`; ACCEPT requires `signatureDigest` (service-enforced — 409 `HANDYMAN_BAST_SIGNATURE_REQUIRED` when missing) and accepts an optional `evidenceRecordId` that must belong to the same scope when supplied.
- Warranty claim: open → submit → approve/reject; withdraw while open.
- `availableActions` on read payloads is a transport projection — render from it, but writes are always re-authorized (stale action → 403/409 is normal).

## 4. Errors (lane-critical)

400 `VALIDATION_ERROR` (strict allow-lists; unknown fields rejected on Care routes) · 401 unauthenticated · 403 `PERMISSION_DENIED`/`BUILDING_ACCESS_DENIED`/`HANDYMAN_CARE_AUTHORITY_DENIED` · 404 `HANDYMAN_SERVICE_REQUEST_NOT_FOUND` · 409 cancellation family (`ALREADY_CANCELLED`, `CANCELLATION_KEY_CONFLICT`, `CANCEL_NOT_ALLOWED`, `CANCEL_COMMITTED`) — full table in CR-HM-18 Frontend handoff §2.4. Idempotent replay (`replayed:true`, same `id`) is success, never an error toast.

## 5. Endpoint table (this lane; generated from the runtime route census)

Every row is in OpenAPI under the given `operationId` (the formerly route-only operations were documented by CR-HM-BACKEND-CONTRACT-FREEZE-02 with exact source-derived schemas; FG-01 CLOSED). Request/response payloads, status codes and `x-error-codes` in the spec are authoritative; route validation modules remain the runtime source.

| Method | Path | operationId / OpenAPI status |
|---|---|---|
| GET | `/handyman/bast/{bastId}` | `getHandymanBastById` |
| POST | `/handyman/bast/{bastId}/accept` | `acceptHandymanBast` |
| POST | `/handyman/bast/{bastId}/reject` | `rejectHandymanBast` |
| POST | `/handyman/bast/{bastId}/sign-off` | `signOffHandymanBast` |
| GET | `/handyman/care/buildings` | `listStandaloneCareBuildings` |
| GET | `/handyman/care/buildings/{buildingId}/authority` | `getBuildingCareAuthority` |
| GET | `/handyman/care/buildings/{buildingId}/catalogue/services` | `listBuildingCareCatalogueServices` |
| GET | `/handyman/care/buildings/{buildingId}/floors` | `listBuildingCareFloors` |
| GET | `/handyman/care/buildings/{buildingId}/requests` | `listStandaloneCareRequests` |
| POST | `/handyman/care/buildings/{buildingId}/requests` | `createBuildingCareRequest` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}` | `getStandaloneCareRequestDetail` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/cancel` | `cancelBuildingCareRequest` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` | `listHandymanCareCommunications` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` | `recordHandymanCareCommunication` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` | `listBuildingCareRequestIntakeEvidence` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` | `uploadBuildingCareRequestIntakeEvidence` |
| GET | `/handyman/care/buildings/{buildingId}/requests/{requestId}/parties` | `listBuildingCareRequestParties` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/payments` | `reportBuildingCareRequestPayment` |
| POST | `/handyman/care/buildings/{buildingId}/requests/{requestId}/payments/{paymentId}/proof` | `uploadBuildingCareRequestPaymentProof` |
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
| POST | `/handyman/care/requests/{requestId}/payments/{paymentId}/proof` | `uploadCareWorkspaceRequestPaymentProof` |
| GET | `/handyman/care/requests/{requestId}/projection` | `getCareWorkspaceOperationalProjection` |
| DELETE | `/handyman/care/session` | `revokeCareWorkspaceSession` |
| POST | `/handyman/care/session` | `admitCareWorkspace` |
| POST | `/handyman/chargeable-additional-works/{workId}/accept` | `acceptHandymanChargeableAdditionalWork` |
| POST | `/handyman/chargeable-additional-works/{workId}/reject` | `rejectHandymanChargeableAdditionalWork` |
| POST | `/handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/payment-proof` | `uploadHandymanCustomerPaymentProof` |
| POST | `/handyman/execution-scopes/{executionScopeId}/variations/{variationId}/tenant-decision` | `recordHandymanVariationTenantDecision` |
| GET | `/handyman/execution-scopes/{id}/status-visibility` | `getHandymanExecutionScopeStatusVisibility` |
| POST | `/handyman/integrations/tenant-slot-choices` | `acceptTenantSlotChoice` |
| GET | `/handyman/quotation-versions/{quotationVersionId}/decision` | `getHandymanQuotationDecision` |
| POST | `/handyman/quotation-versions/{quotationVersionId}/decision` | `decideHandymanQuotation` |
| POST | `/handyman/requests/{handymanRequestId}/visits/{appointmentId}/confirm` | `confirmHandymanTenantSlotVisit` |
| GET | `/handyman/requests/{id}/status-visibility` | `getHandymanRequestStatusVisibility` |
| POST | `/handyman/service-warranties/{warrantyId}/claims` | `openHandymanServiceWarrantyClaim` |
| POST | `/handyman/service-warranty-claims/{claimId}/submit` | `submitHandymanServiceWarrantyClaim` |
| POST | `/handyman/service-warranty-claims/{claimId}/withdraw` | `withdrawHandymanServiceWarrantyClaim` |
| GET | `/handyman/sla/subjects/{subjectType}/{subjectId}` | `getHandymanSubjectSla` |


## Cross-repo gap-closure erratum (2026-10-21, #52 baseline)

Staff Care creation already records CUSTOMER_CARE_BACKEND (BM exchange remains BM_SUPER_APP). Cancellation fact GET is not eligibility; canonical cancel enforces pre-commitment guards. No customer decision impersonation. B1–B4 exact report text remains access-blocked.

See [audit, exact deltas and test evidence](../e2e/CR-HM-BACKEND-CROSS-REPO-E2E-GAP-CLOSURE-01.md), especially §7. Spec erratum hash: `b5edd56f696b3f75ff5f2b5f17ac02366fbab36322908c580faf2f2fc9d10948`; previous header hash is historical. No runtime/DTO/migration change. FG-03/FG-04 remain open; no FINAL FREEZE or live E2E PASS.
