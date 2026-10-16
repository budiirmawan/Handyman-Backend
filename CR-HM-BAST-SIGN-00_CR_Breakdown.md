# CR-HM-BAST-SIGN-00 — Implementation CR Breakdown

## Change Request Implementation Plan

This breakdown maps each Conceptual Requirement (CR) to implementation tasks, ordered by dependency and execution sequence.

---

### CR-HM-BAST-SIGN-01: Add Signature Provenance Tracking
**Purpose**: Track challenge metadata and BAST state hash for signature verification audit trail.

**Tasks**:
1. Add three new columns to `handyman_bast_sign_offs`:
   - `challenge_nonce TEXT` — stores the nonce value for audit/forensics
   - `challenge_expires_at TIMESTAMPTZ` — when the nonce expired
   - `bast_state_hash_at_signing TEXT` — the BAST state hash the signature was computed over
2. Database migration script to add columns (nullable with DEFAULT NULL)
3. Update `insertSignOff` repository function to accept and store these new fields (optional — only used if step-up verification is enabled)
4. Update `toBastSignOffPayload` and `toBastAcceptancePayload` payload transformers to include new fields when present

**Dependencies**: None (application-level changes; no breaking DB changes)

**Est. Effort**: 3 days
- 1 day: Migration script
- 1 day: Repository function updates
- 1 day: Payload transformer updates

---

### CR-HM-BAST-SIGN-02: Implement Challenge-Response Endpoint
**Purpose**: Expose `GET /handyman/bast/:bastId/signing-challenge` for customer sign-off flow.

**Tasks**:
1. Add new route handler in `handyman-bast-api.routes.ts`:
   - `GET /handyman/bast/:bastId/signing-challenge`
2. Add controller function `getBastSigningChallengeHandler` in `handyman-bast-api.controller.ts`:
   - Validate `tenant_company.manage` permission
   - Resolve execution scope from BAST to get `tenant_pic_id`, `building_id`, `client_id`
   - Call `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })`
   - Generate challenge nonce: `crypto.randomUUID()` + `Date.now()` for expiresAt
   - Construct payload structure: `{bastId, executionScopeId, tenantPicId, nonce, expiresAt}`
   - Sign payload with server's private key (or generate challengeSignature for later verification)
   - Return `{ challenge: { nonce, expiresAt, payloadStructure }, challengeSignature }`
3. Add validation in `handyman-bast-api.validation.ts` if needed (minimal — mostly route guard)
4. Document the endpoint in OpenAPI/spec if applicable

**Dependencies**: None — new standalone endpoint

**Est. Effort**: 2 days
- 1 day: Route + controller implementation
- 1 day: Validation and documentation

---

### CR-HM-BAST-SIGN-03: Enhance Signature Validation
**Purpose**: Replace `assertHandymanBastSignature` with full challenge-response verification logic.

**Tasks**:
1. Modify `handyman-bast.service.ts` — `assertHandymanBastSignature` function:
   - Replace simple length/emptiness check with full verification
   - Accept additional parameters: `challengeNonce`, `bastStateHash`, `tenantPicId`
   - Verify signature covers the challenge payload: `{bastId, executionScopeId, tenantPicId, challengeNonce, bastStateHash}`
   - Verification methods:
     a) ECDSA: Use the tenant PIC's public key (from session/organization) to verify the ECDSA signature of the payload
     b) PSrE: Call PSrE provider API to validate certificate and signature (if PSrE mode is active)
   - Return verified `signatureDigest` string on success
   - Throw `AppError` on failure (new error code: `HANDYMAN_INVALID_SIGNATURE` or reuse existing)

2. Modify `handyman-bast-api.validation.ts` — `parseBastSignOffBody`:
   - Add optional parameters for challenge verification context (or pass from controller)
   - Validate that `signatureDigest` is present when `decision === 'ACCEPT'`
   - Add custom validation: "signature must be challenge-verifiable" (could be a frontend-backed check, server-side does full verify)

3. Modify `handyman-bast.service.ts` — `acceptHandymanBast` and `rejectHandymanBast`:
   - Fetch BAST state hash before sign-off: compute `sha256(client_id || execution_scope_id || status || qc_run_id || issued_at || accepted_at || rejected_at || voided_at || created_at || updated_at)`
   - Call enhanced `assertHandymanBastSignature(action, signatureDigest, challengeNonce, bastStateHash, tenantPicId)`
   - Pass verified signature through to sign-off insertion

4. Update `handyman-bast.errors.ts` if adding new error codes:
   - `HANDYMAN_INVALID_SIGNATURE` — signature verification failed
   - `HANDYMAN_SIGNATURE_NOT_CHALLENGE_BOUND` — signature doesn't cover required fields

**Dependencies**: CR-02 (challenge endpoint must exist before validation can use it)

**Est. Effort**: 4 days
- 1 day: Enhanced signature function logic
- 1 day: Error code updates and validation changes
- 1 day: Integration in accept/reject service flow
- 1 day: Testing and regression

---

### CR-HM-BAST-SIGN-04: Add Tenant PIC Binding to Sign-Off
**Purpose**: Ensure `signatureDigest` is cryptographically bound to the specific `tenant_pic_id` from the execution scope.

**Tasks**:
1. In the enhanced `assertHandymanBastSignature` (from CR-03), always include `tenantPicId` as a required field in the challenge payload
2. The challenge payload structure (from CR-02) already includes `tenantPicId` — ensure it's populated from the execution scope
3. Add validation: if `tenantPicId` in the signature payload doesn't match the execution scope's `tenant_pic_id`, reject the sign-off
4. Update `applyCustomerSignOff` service function (in `handyman-bast.service.ts`):
   - Resolve `tenant_pic_id` from the execution scope (via `handymanScopeAssignmentRepository.findScopeById`)
   - Pass `tenantPicId` to `assertHandymanBastSignature`
   - If the sign-off's `tenant_pic_id` doesn't match, throw error before proceeding

**Dependencies**: CR-02, CR-03 (challenge endpoint + enhanced validation)

**Est. Effort**: 3 days
- 1 day: Scope resolution and tenant PIC binding in service
- 1 day: Validation logic in signature function
- 1 day: Integration testing

---

### CR-HM-BAST-SIGN-05: Add BAST State Hash Computation
**Purpose**: Compute and store cryptographic hash of BAST document state at signing time for signature binding.

**Tasks**:
1. In `handyman-bast.repository.ts` — `updateBastStatus` function:
   - After computing the new status, also compute `state_hash = sha256(client_id || execution_scope_id || status || qc_run_id || issued_at || accepted_at || rejected_at || voided_at || created_at || updated_at)`
   - Store the hash in the `state_hash` column of the updated BAST document
   - (If the `state_hash` column hasn't been added yet — see migration decision; could compute on-the-fly instead of storing)

   **Alternative**: Compute the hash on-the-fly in the signature verification function using the BAST record's current columns, without adding a new DB column. This is simpler and avoids migration.

   **Decision**: Use on-the-fly computation (no new column needed). The hash is computed from the BAST record fields already present in the UPDATE RETURNING clause.

2. Create utility function `computeBastStateHash(bastRecord)`:
   ```typescript
   function computeBastStateHash(bast: HandymanBastRecord): string {
     const inputs = [
       bast.clientId,
       bast.executionScopeId,
       bast.status,
       bast.qcRunId,
       bast.issuedAt,
       bast.acceptedAt,
       bast.rejectedAt,
       bast.voidedAt,
       bast.createdAt,
       bast.updatedAt,
     ].filter(Boolean).join('|');
     return crypto.createHash('sha256').update(inputs).digest('hex');
   }
   ```

3. Use this function in `acceptHandymanBast` and `rejectHandymanBast`:
   - After BAST status is updated (or before), compute the state hash
   - Pass to `assertHandymanBastSignature` as `bastStateHash`

**Dependencies**: None — utility function using existing BAST record fields

**Est. Effort**: 3 days
- 1 day: Utility function creation
- 1 day: Integration into accept/reject flow
- 1 day: Testing

---

### CR-HM-BAST-SIGN-06: Backend Authorization Updates
**Purpose**: Replace `canAccessClient` sole guard with `assertBuildingScopedResourceAccess` in all BAST paths; add challenge verification middleware.

**Tasks**:
1. Review ALL BAST-related handlers for `canAccessClient` usage:
   - `handyman-bast-api.controller.ts` — `getExecutionScopeBastHandler`, `getBastByIdHandler`
   - `handyman-bast-api.controller.ts` — `postBastAcceptHandler`, `postBastRejectHandler`, `postBastSignOffHandler`
   - `handyman-bast-worker-api.controller.ts` — all worker handlers

2. Replace `canAccessClient` with `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })` in:
   - `getExecutionScopeBastHandler`: Resolve scope → get buildingId/clientId → call assertBuildingScopedResourceAccess
   - `getBastByIdHandler`: Same — resolve from bast → scope → building
   - `postBastAcceptHandler`: Same — before calling `acceptHandymanBast`
   - `postBastRejectHandler`: Same — before calling `rejectHandymanBast`
   - `postBastSignOffHandler`: Same — before dispatching to accept/reject
   - Worker handlers (`postWorkerBastPrepareHandler`, `postWorkerBastIssueHandler`, `postWorkerBastVoidHandler`): Same pattern

3. Add challenge verification middleware (optional — could be inline in service layer):
   - Create reusable middleware function `verifyChallengeResponse(req, res, next)` 
   - Or integrate signature verification directly into `acceptHandymanBast`/`rejectHandymanBast`
   - Middleware should: fetch challenge from session or validate `signatureDigest` against stored challenge (if session stores nonce)

4. Update RBAC middleware documentation:
   - Add note: `canAccessClient` is NOT sufficient for BAST operations — building guard is mandatory
   - Ensure all BAST routes use the correct permission (`tenant_company.manage` for customer sign-off)

**Dependencies**: None — application-level guard reorganization

**Est. Effort**: 4 days
- 2 days: Review and replace `canAccessClient` with building guard in all BAST handlers
- 1 day: Add/challenge verification integration
- 1 day: Testing and regression

---

### CR-HM-BAST-SIGN-07: Negative Security Test Implementation
**Purpose**: Implement and test all 28 NST test cases from the security matrix.

**Tasks**:
1. Create test script file `scripts/negative-security-tests.ts` or use existing test framework (e.g., Jest + Supertest)
2. Implement each test case as an automated test:
   - NST-01 through NST-28 (as documented in the Negative Security Test Matrix)
3. Run tests against local/dev backend
4. Fix any failures (likely several — validates the security guards are working)
5. Document test results and ensure 100% pass rate

**Test scenarios to automate**:
- Empty signatureDigest for ACCEPT → 400
- Arbitrary hash without challenge binding → 400
- REJECT without rejectReason → 400
- idempotencyKey replay → 200 (replay) or 409
- Second sign-off for same event → 409
- ACCEPT on VOIDed BAST → 409
- ISSUE without QC PASS → 409
- ACCEPT on DRAFT BAST → 409
- signatureDigest > 512 chars → 400
- Cross-client sign-off → 403
- No building guard → 403
- Stale nonce replay → 401/400
- Wrong execution_scope evidenceRecordId → 400
- Concurrent ACCEPT race → 409
- VOID without voidReason → 400
- Delete BAST → 409
- Update BAST identity → 409
- Signature from wrong tenant PIC → 401/400
- ACCEPT after ACCEPTED/REJECTED → 409
- Challenge nonce expiry → 400/401
- Signature without tenantPicId binding → 401
- Signature without bastStateHash binding → 400
- rejectReason > 2000 chars → 400
- Invalid UUID format → 400
- Sign-off with non-existent event_id → 404
- Second ACCEPT after ACCEPTED → 409
- Double ISSUE → 409
- Cross-building access → 403
- Invalid UUID format fields → 400
- Sign-off with non-existent event → 404

**Dependencies**: CR-02, CR-03, CR-04 (challenge endpoint + enhanced validation + tenant PIC binding must be implemented first)

**Est. Effort**: 5 days
- 2 days: Test script creation and framework setup
- 3 days: Implementing all 28 test cases and running against backend

---

### CR-HM-BAST-SIGN-08: Frontend Challenge Flow
**Purpose**: Implement frontend: challenge fetch, e-signature presentation, signature submission flow.

**Tasks**:
1. Create new React component `BastSignOffModal` (or modify existing BAST detail page):
   - Fetches challenge on open: `GET /handyman/bast/:bastId/signing-challenge`
   - Displays payload JSON in expandable format
   - Has "Sign Payload" button that triggers e-signature tool
   - Has Accept/Submit Reject buttons

2. Integrate e-signature tool (or mock for development):
   - For production: Integrate with approved e-signature vendor's web widget
   - For development: Use mock that returns a test ECDSA signature base64url string
   - The tool should present the payload JSON and return a signature

3. Implement request body construction for ACCEPT/REJECT:
   - `idempotencyKey` (from local storage or generated fresh)
   - `signatureDigest` (from e-signature tool output)
   - `evidenceRecordId` (optional, from evidence linking UI)
   - For REJECT: `rejectReason` text input value

4. Implement submission flow:
   - POST to `/handyman/bast/:bastId/accept` or `/handyman/bast/:bastId/reject`
   - Show loading spinner during submission
   - Handle success: close modal, refresh BAST detail, show success toast
   - Handle error: display backend error message; allow retry

5. Implement idempotency key management:
   - Generate UUID v4 on modal open
   - Store in sessionStorage keyed by `bastId`
   - Reuse on modal re-open within same session

**Dependencies**: Design freeze on signature model (CR-01 through CR-04 should be substantially complete)

**Est. Effort**: 4 days
- 1 day: Modal component creation and challenge fetch
- 1 day: E-signature tool integration (or mock)
- 1 day: Submit flow and error handling
- 1 day: Idempotency key management and polishing

---

### CR-HM-BAST-SIGN-09: Evidence Record Binding Enhancement
**Purpose**: Enhance sign-off validation: if `evidenceRecordId` is provided, verify FK to `handyman_evidence_records` with matching `execution_scope_id` and `client_id`.

**Tasks**:
1. In `acceptHandymanBast` and `rejectHandymanBast` service functions (in `handyman-bast.service.ts`):
   - If `input.evidenceRecordId` is provided and not empty:
     a. Query `handyman_evidence_records` by `id = evidenceRecordId`
     b. Check `execution_scope_id` matches `bast.execution_scope_id`
     c. Check `client_id` matches `bast.client_id`
     d. If either mismatch throws `handymanBastValidationError('evidenceRecordId')`
   - If `evidenceRecordId` is null or empty → skip validation (optional, existing behavior)

2. Update `handyman-bast-api.validation.ts` — `parseBastSignOffBody`:
   - Keep existing UUID format validation for `evidenceRecordId`
   - Add cross-document FK validation message in error docs (not enforced in DB, but in application logic)

3. Update sign-off payload transformers to include evidence verification status:
   - `toBastSignOffPayload`: Include `evidenceRecordId` and optionally `evidenceVerified: boolean`
   - `toBastAcceptancePayload`: Show whether evidence is linked/verified

**Dependencies**: Existing `handyman_evidence_records` table structure — no new DB changes needed

**Est. Effort**: 3 days
- 1 day: Service function evidence validation logic
- 1 day: Validation updates and error messages
- 1 day: Testing and verification

---

### CR-HM-BAST-SIGN-10: Documentation and Sign-Off
**Purpose**: Finalize all design docs, audit trails, and hand-off guides. Complete the deliverables for this CR.

**Tasks**:
1. Review all created markdown documents for consistency and completeness:
   - CR-HM-BAST-SIGN-00_Audit_Existing_BAST.md
   - CR-HM-BAST-SIGN-00_Design_Authority.md
   - CR-HM-BAST-SIGN-00_Signature_Options.md
   - CR-HM-BAST-SIGN-00_Existing_Infrastructure_Reuse.md
   - CR-HM-BAST-SIGN-00_Deliverables_Matrix.md
   - CR-HM-BAST-SIGN-00_Lifecycle_State_Diagram.md
   - CR-HM-BAST-SIGN-00_Authority_Contract.md
   - CR-HM-BAST-SIGN-00_Conceptual_Data_Model.md
   - CR-HM-BAST-SIGN-00_API_Proposals.md
   - CR-HM-BAST-SIGN-00_Authorization_Matrix.md
   - CR-HM-BAST-SIGN-00_Negative_Security_Tests.md
   - CR-HM-BAST-SIGN-00_Frontend_Handoff.md
   - CR-HM-BAST-SIGN-00_CR_Breakdown.md
   - CR-HM-BAST-SIGN-00_Unresolved_Decisions.md

2. Ensure all code changes are documented with JSDoc comments where functions are modified
3. Verify that all triggers and DB constraints are accounted for in the design
4. Final sign-off by lead developer/architect
5. Archive design documents in the repository's design/ directory (if applicable)

**Dependencies**: All previous CRs (01-09) should be substantially complete before this CR

**Est. Effort**: 2 days
- 1 day: Document review and consistency check
- 1 day: Final sign-off and archival

---

## Implementation Order Summary

| CR ID | Title | Dependent On | Order |
|---|---|---|---|
| 01 | Signature Provenance Tracking | None | 1 |
| 02 | Challenge-Response Endpoint | 01 | 2 |
| 03 | Enhanced Signature Validation | 02 | 3 |
| 04 | Tenant PIC Binding | 02, 03 | 4 |
| 05 | BAST State Hash | None (uses existing fields) | 5 |
| 06 | Authorization Updates | 03 | 6 |
| 07 | NST Implementation | 02, 03, 04 | 7 |
| 08 | Frontend Challenge Flow | 02, 03, 04, 06 | 8 |
| 09 | Evidence Record Binding | 03, 04 | 9 |
| 10 | Documentation | 01-09 | 10 |

**Total estimated effort**: 34 days (can be parallelized where dependencies allow, but critical path is ~25 days)