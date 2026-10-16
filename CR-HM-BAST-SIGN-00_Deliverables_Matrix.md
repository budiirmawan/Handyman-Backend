# CR-HM-BAST-SIGN-00 — Deliverables Matrix

## 5. Deliverables Overview

### 5.1 Trusted BAST Authority Contract
- **File**: `CR-HM-BAST-SIGN-00_Authority_Contract.md` (in progress)
- **Scope**: Defines the authoritative binding: `Authenticated User → Exact Tenant PIC → Exact Handyman Request → Current ISSUED BAST → Explicit Decision → Verifiable Evidence → Immutable Audit`
- **Key clauses**:
  1. Authentication context binding
  2. Tenant PIC exact match requirement
  3. Handyman request exact match requirement
  4. Current ISSUED BAST status gate
  5. Explicit decision (ACCEPT/REJECT) requirement
  6. Verifiable evidence provenance
  7. Immutable audit trail enforcement
  8. Expiration and anti-replay guarantees
  9. Revocation and VOID procedures
  10. Concurrent decision handling

### 5.2 Lifecycle/State Diagram
- **File**: `CR-HM-BAST-SIGN-00_Lifecycle_State_Diagram.md` (in progress)
- **Statuses**: DRAFT → ISSUED → ACCEPTED/REJECTED, and VOID from DRAFT/ISSUED
- **Transitions**:
  - DRAFT --(PREPARE)--> DRAFT (idempotent replay)
  - DRAFT --(ISSUE, with QC gate)--> ISSUED
  - ISSUED --(ACCEPT, with signature+QC gate)--> ACCEPTED
  - ISSUED --(REJECT, with signature+reason)--> REJECTED
  - DRAFT --(VOID, with reason)--> VOID
  - ISSUED --(VOID, with reason)--> VOID
  - VOID --(PREPARE)--> DRAFT (new BAST for same scope)
- **Events**: PREPARE, ISSUE, VOID, ACCEPT, REJECT
- **Sign-offs**: One per ACCEPT/REJECT event, with signature_digest and optional evidence_record_id

### 5.3 Conceptual Data Model and Required Migrations
- **File**: `CR-HM-BAST-SIGN-00_Conceptual_Data_Model.md` (in progress)
- **Existing tables** (reuse):
  - `handyman_bast_documents` - core document with status, qc_run_id, timestamps
  - `handyman_bast_events` - append-only events with idempotency_key
  - `handyman_bast_sign_offs` - sign-off with decision, signatureDigest, evidenceRecordId, rejectReason
- **New/augmented columns/ tables**:
  - BAST document: `signature_hash` column - hash of BAST state at signing time (for replay protection)
  - Sign-off: Enhanced `signature_digest` validation (must be challenge-response verifiable)
  - New migration: `signature_provenance` table or columns to track challenge metadata
- **Triggers** (reuse/existing):
  - Identity immutability guards (client/scope cannot change)
  - Deletion blockers
  - Append-only enforcement
- **Required migrations** (new):
  1. Add `challenge_nonce` or `signature_provenance` columns to support step-up verification
  2. Add `ba_state_hash` to `handyman_bast_documents` for signature binding
  3. Migration to add constraint: `signature_digest` must be verifiable against stored challenge

### 5.4 API Request/Response Proposals
- **File**: `CR-HM-BAST-SIGN-00_API_Proposals.md` (in progress)

#### GET /handyman/bast/:bastId
```
Response: 200 { bast, acceptance, events, signOffs }
```
- `bast`: id, executionScopeId, status, qcRunId, issuedAt, acceptedAt, rejectedAt, voidedAt, createdAt, updatedAt, artifact
- `acceptance`: status, customerAccepted, warrantyStartEligible, issuedAt, acceptedAt, rejectedAt, voidedAt, artifactRef, approvedSignOff, signOffComplete
- `events`: [id, eventType, actorUserId, occurredAt, createdAt, voidReason?]
- `signOffs`: [id, decision, signatureDigest, evidenceRecordId, rejectReason, createdAt]

#### GET /handyman/execution-scopes/:executionScopeId/bast
```
Response: 200 { executionScopeId, bast, acceptance, events, signOffs }
```

#### POST /handyman/bast/:bastId/accept
```
Request body: {
  idempotencyKey: string,       // required, 1-200 chars
  signatureDigest: string,      // required - challenge-response signature
  evidenceRecordId: string | null,  // optional UUID
  rejectReason: string | null     // not present for ACCEPT
}
Response: 200 { bast, acceptance, event, signOff }

#### POST /handyman/bast/:bastId/reject
```
Request body: {
  idempotencyKey: string,       // required, 1-200 chars
  signatureDigest: string,      // required - challenge-response signature
  evidenceRecordId: string | null,  // optional UUID
  rejectReason: string          // required for REJECT, trimmed to 2000 chars
}
Response: 200 { bast, acceptance, event, signOff }
```

#### GET /handyman/bast/:bastId/signing-challenge (NEW)
```
Request: auth header, bastId path param
Response: 200 { challenge: { nonce, expiresAt, payloadStructure }, challengeSignature }
```
- Server generates cryptographic nonce
- Payload to sign: `{bastId, executionScopeId, tenantPicId, nonce, expiresAt}`
- challengeSignature: server's private key sign of the payload

#### POST /handyman/bast/:bastId/verify-signature (NEW, internal)
```
Request body: { signatureDigest, challengeNonce, ... }
Response: 200 { valid: boolean }
```
- Verifies that signatureDigest covers the challenge payload correctly

### 5.5 Backend Authorization Matrix
- **File**: `CR-HM-BAST-SIGN-00_Authorization_Matrix.md` (in progress)

| Operation | Required Permission | Additional Guards |
|---|---|---|
| `GET /handyman/bast/:bastId` | `tenant_company.read` | `assertBuildingScopedResourceAccess(actor, {clientId, buildingId from scope})` |
| `GET /handyman/execution-scopes/:eId/bast` | `tenant_company.read` | `assertBuildingScopedResourceAccess(actor, {clientId, buildingId from scope})` |
| `POST /handyman/bast/:bastId/accept` | `tenant_company.manage` | 1. `assertBuildingScopedResourceAccess` 2. Challenge-response signature verification 3. QC gate (`assertCurrentGuardedHandymanQcPass`) if status=ISSUED |
| `POST /handyman/bast/:bastId/reject` | `tenant_company.manage` | 1. `assertBuildingScopedResourceAccess` 2. Challenge-response signature verification 3. QC gate if status=ISSUED 4. `rejectReason` mandatory |
| `POST /handyman/field/bast/:bastId/prepare` | `handyman.bast.manage` | 1. `loadWorkerBastLaneScope` (CURRENT Crew Lead) 2. Building guard 3. QC gate |
| `POST /handyman/field/bast/:bastId/issue` | `handyman.bast.manage` | 1. `loadWorkerBastLaneBast` 2. expectedVersion guard 3. QC gate |
| `POST /handyman/field/bast/:bastId/void` | `handyman.bast.manage` | 1. `loadWorkerBastLaneBast` 2. expectedVersion guard 3. Void reason required |
| `POST /handyman/bast/:bastId/sign-off` | `tenant_company.manage` | Delegates to acceptHandymanBast or rejectHandymanBast (same guards) |

**NOT allowed**: `canAccessClient` as sole guard for BAST operations. The building guard from the execution scope is mandatory.

### 5.6 Negative Security Test Matrix
- **File**: `CR-HM-BAST-SIGN-00_Negative_Security_Tests.md` (in progress)

| Test ID | Description | Expected Behavior |
|---|---|---|
| NST-01 | Submit ACCEPT with empty `signatureDigest` | 400 - `handymanBastSignatureRequiredError` |
| NST-02 | Submit ACCEPT with arbitrary 512-char hash (no challenge binding) | 400 - validation error (signature not challenge-bound) |
| NST-03 | Submit REJECT without `rejectReason` | 400 - validation error (rejectReason required) |
| NST-04 | Replay same idempotencyKey for ACCEPT after first success | 200 (replay) - returns original event |
| NST-05 | Second ACCEPT for same event (different key) | 409 - UNIQUE constraint violation on event_id |
| NST-06 | ACCEPT on VOIDed BAST | 409 - BAST status gate prevents transition from VOID |
| NST-07 | ISSUE without current QC PASS | 409 - `handymanBastQcNotReadyError` from `assertCurrentGuardedHandymanQcPass` |
| NST-08 | ACCEPT on DRAFT BAST | 409 - status transition: DRAFT → ACCEPT not allowed (must be ISSUED) |
| NST-09 | Submit signatureDigest > 512 chars | 400 - `handymanBastSignatureRequiredError` |
| NST-10 | Cross-client BAST access (different client_id in sign-off) | 403 - trigger blocks client/scope swap |
| NST-11 | No building guard check | 403 - `assertBuildingScopedResourceAccess` rejects |
| NST-12 | Replay old signature without challenge nonce | 401/400 - signature verification fails (challenge mismatch) |
| NST-13 | ACCEPT with evidenceRecordId pointing to wrong execution_scope | 400 - FK constraint: evidence must match bast's execution_scope_id |
| NST-14 | Concurrent ACCEPT race condition (two requests simultaneously) | 409 - optimistic concurrency: second request gets ILLEGAL_TRANSITION |
| NST-15 | VOID without voidReason (worker API) | 400 - validation error (voidReason required in metadata) |
| NST-16 | Delete BAST document | 409 - trigger blocks deletion: "Handyman BAST documents cannot be deleted" |
| NST-17 | Update BAST client_id or execution_scope_id | 409 - trigger blocks identity mutation: "Handyman BAST identity (client/scope) is immutable" |
| NST-18 | Sign-off with signature from wrong tenant/PIC | 400/401 - signature verification fails (tenantPicId mismatch) |
| NST-19 | Submit ACCEPT after BAST already ACCEPTED/REJECTED | 409 - status gate prevents transition from non-ISSUED state |
| NST-20 | Challenge nonce replay after expiration ( > 5 minutes) | 400/401 - nonce expired error |

### 5.7 Exact Frontend Handoff Requirements
- **File**: `CR-HM-BAST-SIGN-00_Frontend_Handoff.md` (in progress)

#### Page/Component Requirements:
1. **BAST Detail Page** (`/handyman/bast/:bastId`):
   - Display BAST status, dates, artifact reference
   - Show acceptance status (pending/accepted/rejected)
   - Show sign-off audit (who, when, signature verification status)
   - Read-only for non-manage users

2. **Accept/Reject Modal** (triggered from BAST detail):
   - Must first fetch signing challenge: `GET /handyman/bast/:bastId/signing-challenge`
   - Display challenge payload that customer must sign
   - Accept: Customer signs the challenge payload with their e-signature tool
   - Reject: Provide `rejectReason` text input (mandatory)
   - Submit: `POST /handyman/bast/:bastId/accept` or `POST /handyman/bast/:bastId/reject`
   - On success: Show updated BAST status and acceptance

3. **Signing Challenge Flow**:
   - Frontend: `GET /handyman/bast/:bastId/signing-challenge`
   - Backend: Returns `{ nonce, expiresAt, payloadStructure }`
   - Frontend displays: "Please sign the following payload with your e-signature tool: [payload JSON]"
   - Frontend captures the `signatureDigest` from the customer's signature output
   - Frontend submits: `POST /handyman/bast/:bastId/accept` with `signatureDigest`, `idempotencyKey`

4. **Error Handling Frontend**:
   - Signature verification failure: Show "Signature verification failed. Please try again."
   - QC not ready: Show "Quality check not complete. Wait for inspection to pass."
   - Building access denied: Show "You don't have access to this BAST."
   - Idempotency conflict: Show "Your request has already been processed."

5. **API Integration Checklist**:
   - [ ] `GET /handyman/bast/:bastId` - fetch BAST detail
   - [ ] `GET /handyman/execution-scopes/:executionScopeId/bast` - fetch by scope
   - [ ] `GET /handyman/bast/:bastId/signing-challenge` - NEW: get challenge nonce
   - [ ] `POST /handyman/bast/:bastId/accept` - submit ACCEPT with signature
   - [ ] `POST /handyman/bast/:bastId/reject` - submit REJECT with reason
   - [ ] Authentication: `tenant_company.manage` for accept/reject
   - [ ] Error boundaries for all API failures

### 5.8 Implementation CR Breakdown
- **File**: `CR-HM-BAST-SIGN-00_CR_Breakdown.md` (in progress)

| CR ID | Title | Description | Est. Effort |
|---|---|---|---|
| CR-HM-BAST-SIGN-01 | Add signature provenance tracking | Add `signature_provenance` columns/fields to BAST/signet tables to track challenge nonce, tenant PIC binding, and verification status | 3 days |
| CR-HM-BAST-SIGN-02 | Implement challenge-response endpoint | `GET /handyman/bast/:bastId/signing-challenge` - generate nonce, sign payload, return to frontend | 2 days |
| CR-HM-BAST-SIGN-03 | Enhance signature validation | Replace `assertHandymanBastSignature` with challenge-response verification logic; validate signature covers required fields | 4 days |
| CR-HM-BAST-SIGN-04 | Add tenant PIC binding to sign-off | Ensure `signatureDigest` is bound to the specific `tenant_pic_id` from the execution scope | 3 days |
| CR-HM-BAST-SIGN-05 | Update BAST document state hash | Add `stateHash` column to `handyman_bast_documents`; compute and store hash on each status transition | 3 days |
| CR-HM-BAST-SIGN-06 | Backend authorization updates | Replace `canAccessClient` sole guard with `assertBuildingScopedResourceAccess` in all BAST paths; add challenge verification middleware | 4 days |
| CR-HM-BAST-SIGN-07 | Negative security test implementation | Implement and test all NST test cases from the security matrix | 5 days |
| CR-HM-BAST-SIGN-08 | Frontend challenge flow | Implement frontend: challenge fetch, e-signature presentation, signature submission flow | 4 days |
| CR-HM-BAST-SIGN-09 | Evidence record binding | Enhance sign-off validation: if `evidenceRecordId` provided, verify FK to `handyman_evidence_records` with matching `execution_scope_id` and `client_id` | 3 days |
| CR-HM-BAST-SIGN-10 | Documentation and sign-off | Finalize all design docs, audit trails, and hand-off guides | 2 days |

**Total estimated effort**: 34 days (parallelizable across teams)

### 5.9 Explicit Unresolved Product Decisions
- **File**: `CR-HM-BAST-SIGN-00_Unresolved_Decisions.md` (in progress)

| Decision ID | Option A | Option B | Default/Recommended | Decision Maker |
|---|---|---|---|---|
| SD-01 | PSrE required for all contracts | PSrE optional, Option A (authenticated e-signature) default for all | **Option A default** (this session) | Product Lead |
| SD-02 | Challenge nonce expiry: 5 min | Challenge nonce expiry: 15 min | **5 min** (balance security vs UX) | Product Lead |
| SD-03 | Approved signature algorithms: ECDSA P-256 only | Approved: ECDSA P-256 / P-384 / RSA-2048 | **ECDSA P-256 / P-384** | Security Lead |
| SD-04 | rejectReason mandatory for REJECT | rejectReason optional (error if missing) | **Mandatory** (current constraint) | Product Lead |
| SD-05 | Evidence record mandatory for ACCEPT | evidenceRecordId optional for ACCEPT | **Optional** (current design) | Product Lead |
| SD-06 | Step-up verification for ALL ACCEPT | Step-up only for "high-risk" contracts | **All external customers** (recommended) | Product Lead |
| SD-07 | Internal Customer Care bypass step-up | No bypass; challenge for all | **Waivable for verified internal actors** | Security Lead |
| SD-08 | Warranty auto-start on ACCEPT | ACCEPT → warranty immediately active | **ACCEPTed warrants further QC/verification before warranty** | Ops Lead |
| SD-09 | VOID reason stored in event metadata only | VOID reason also stored as document column | **Event metadata only** (existing pattern) | Product Lead |
| SD-10 | Concurrent ACCEPT: last-write-wins vs error | Concurrent: reject second, or allow last-write-wins | **Error (409 concurrency conflict)** | Security Lead |

> **GOVERNANCE CORRECTION — CR-HM-BM-CARE-AUTH-01.** The `Default/Recommended`
> column above records the **Arena session default**, not a business decision. No
> Product Lead, Security Lead, Ops Lead or Legal approval for SD-01…SD-15 exists
> anywhere in the repository; the only approval evidence was self-declared in the
> companion document. Status is **Proposed** (SD-11 **Pending** on Legal). The
> authoritative, corrected register is
> `CR-HM-BAST-SIGN-00_Unresolved_Decisions.md` §Decision Table.
>
> **SD-16…SD-19 remain Approved** — they restate the established
> TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN business and security principles
> rather than inventing policy.
>
> **Runtime consequence:** ECDSA/PSrE signature policy (SD-01, SD-03, SD-11,
> SD-13), optional-evidence relaxation (SD-05), step-up waiver / internal bypass
> (SD-06, SD-07) and warranty auto-start (SD-08) are **not implemented as runtime
> authority** and must not be, until a named decision maker records approval.
