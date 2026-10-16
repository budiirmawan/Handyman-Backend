# CR-HM-BAST-SIGN-00 — Trusted Customer BAST Authority Design

## 1. Audit Existing BAST

### 1.1 Worker PREPARE / ISSUE / VOID
- **PREPARE** (`POST /handyman/field/execution-scopes/:executionScopeId/bast/prepare`): Creates a DRAFT BAST anchored to the latest guarded Supervisor QC PASS. Requires `handyman.bast.manage` permission + Building + CURRENT Crew Lead authorization. Idempotent via `idempotencyKey`.
- **ISSUE** (`POST /handyman/field/bast/:bastId/issue`): DRAFT → ISSUED. Requires CURRENT Crew Lead with expectedVersion guard. Does NOT issue for customer acceptance.
- **VOID** (`POST /handyman/field/bast/:bastId/void`): DRAFT|ISSUED → VOID with required reason in append-only event metadata. Historical documents and event history are never deleted.

### 1.2 Customer ACCEPT / REJECT
- **ACCEPT** (`POST /handyman/bast/:bastId/accept`): ISSUED → ACCEPTED. Requires `tenant_company.manage` permission + `signatureDigest`. Triggers QC re-guard.
- **REJECT** (`POST /handyman/bast/:bastId/reject`): ISSUED → REJECTED. Requires `tenant_company.manage` permission + `signatureDigest` + `rejectReason`.

### 1.3 QC PASS and reinspection authority
- `assertCurrentGuardedHandymanQcPass` enforces a stringent checklist:
  - Latest QC run must be PASSED with the expected `expectedRunId`
  - All required checklist items must have outcome PASS
  - No unresolved defects (all VERIFIED)
  - Work sessions completed (COMPLETED or CHECKED_OUT)
  - QC evidence uploads verified and bound to the execution scope/building/client
  - No corrective FAIL since the last successful PASS
- This gate applies to both BAST ISSUE and ACCEPT actions.

### 1.4 `signatureDigest` handling
- Stored in `handyman_bast_sign_offs.signature_digest` as TEXT (max 512 chars)
- **Critical gap**: `assertHandymanBastSignature` only checks:
  - Non-empty for ACCEPT actions
  - Length <= 512
  - No cryptographic verification or provenance checking
  - **No binding to authenticated user, tenant PIC, or handyman request**
  - Arbitrary browser-supplied hashes are accepted as proof

### 1.5 Authenticated User / Tenant PIC binding
- **Current state**: The sign-off service (`applyCustomerSignOff`) does resolve the `scope` from `bast.executionScopeId` and checks `assertBuildingScopedResourceAccess`, but:
  - The actor is from `req.auth.userId` (Customer Care staff)
  - There is **no binding** between the authenticated user and the Tenant PIC (`tenant_pics.id`)
  - There is **no binding** between the actor and the specific `handyman_request_id`
  - The customer identity is not cryptographically verified

### 1.6 Evidence storage and verification
- Evidence records (`handyman_evidence_records`) are bound to `execution_scope_id` and `client_id`
- QC evidence uploads (`handyman_field_evidence_uploads`) must be VERIFIED with `attachment_reference`, `purpose = 'QC_EVIDENCE'`
- The QC gate (`assertCurrentGuardedHandymanQcPass`) verifies evidence bindings including:
  - `execution_scope_id`, `client_id`, `building_id` match
  - `upload_status = 'VERIFIED'` and `verified_at` is recent
  - Bytes are re-hashed via `assertVerifiedManagedEvidenceReference`
- **Gap**: Customer ACCEPT/REJECT does not independently verify evidence beyond the QC gate. The `signatureDigest` is not cross-referenced with evidence records.

### 1.7 Versioning, idempotency and audit records
- **Events** (`handyman_bast_events`): PREPARE/ISSUE/VOID/ACCEPT/REJECT with `idempotency_key`. UNIQUE on `(bast_id, event_type, idempotency_key)`.
- **Sign-offs** (`handyman_bast_sign_offs`): One per `event_id`. UNIQUE on `event_id`.
- **Triggers prevent**: deletion, identity mutation (client/scope swap), update/delete on events.
- **Idempotency**: Handled at repository level via `findEventByIdempotency` + replay logic.

### 1.8 Why current customer signature provenance is NOT trustworthy
1. **No user-Tenant PIC binding**: The `signatureDigest` from the browser is accepted without verification that it was generated on behalf of the correct tenant/PIC.
2. **No request binding**: No cryptographic binding between the signature and the specific `handyman_request_id` / `execution_scope_id`.
3. **Arbitrary hash acceptance**: `signatureDigest` is just a TEXT field - any string passes validation. There is no proof it came from an authorized signatory.
4. **No step-up verification**: No challenge-response or one-time nonce to prevent replay.
5. **No evidence provenance link**: The `evidenceRecordId` in sign-offs is optional and not cryptographically bound to the signature.
6. **Customer Care actor vs. actual customer**: The actor is from `req.auth.userId` (Customer Care staff), not the actual customer. There's no way to verify the customer's intent.