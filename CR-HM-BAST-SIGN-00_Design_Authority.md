# CR-HM-BAST-SIGN-00 — Authority Design

## 2. Proposed Secure Model

#

## 4. CR-HM-BM-CARE-HANDOFF-01 Business Correction Model

The following explicitly documents the CR-HM-BM-CARE-HANDOFF-01 business correction
within the Authority Design, ensuring no confusion with the BAST customer sign-off model:

### TENANT / TENANT PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN

1. **Customer Care Building is the primary operational communication bridge.**
   The Building Customer Care actor is the official bridge — all care-mediated operations
   pass through this layer. No direct Tenant→Handyman path is required or permitted.

2. **The Tenant does not require a direct Handyman account.**
   Tenant/PIC participants have no Handyman account requirement. The Building Customer
   Care actor authenticates via backend session; the Tenant's decision evidence is
   conveyed through the Building's mediated channel.

3. **The authenticated recording actor is Building Customer Care; the actual decision maker is Tenant/PIC.**
   - `recordedByUserId` derived from authenticated Backend session (not request body)
   - Tenant/PIC decision evidenced by exchange token hash (single-use, provenance only)
   - Care cannot impersonate Tenant (token binding prevents this)

4. **A BM handoff exchange token does not prove Tenant approval.**
   The exchange token hash is a provenance identifier for audit — it records which
   token was consumed but does NOT constitute proof of Tenant approval of quotation,
   variation, or BAST. Decision evidence and verification status are separate from
   the token's operational purpose.

5. **BAST ACCEPT, quotation approval and variation approval require verifiable decision provenance,
   still an unresolved authority contract.**
   A Care decision record (CONFIRM/REJECT) does NOT automatically trigger quotation
   APPROVE, variation APPROVE, or BAST ACCEPT. Each commercial decision requires its
   own verifiable provenance chain. The authority contract for commercial decision
   provenance remains unresolved and is fail-closed without explicit product authority.
## Authentication and Optional Step-Up Verification
- **Primary auth**: `req.auth.userId` identifies the actor (Customer Care staff or Crew Lead).
- **Step-up verification**: Required for customer-facing ACCEPT/REJECT:
  1. **One-time challenge**: Server generates a cryptographic challenge bound to `(bastId, executionScopeId, tenantPicId, nonce)`.
  2. **Client-side signing**: The customer's device signs the challenge with a private key or approved e-signature mechanism.
  3. **Server verification**: The `signatureDigest` submitted in the request must be verified against the challenge + tenant PIC binding.
  4. **Optional for internal**: Step-up may be waived for internal Customer Care actors with verified session identity, but MUST be enforced for external customer requests.

### Explicit Intent and Consent
- **Decision**: `ACCEPT` or `REJECT` — explicitly recorded in `handyman_bast_sign_offs.decision`.
- **Rejection reason**: Free-text field (max 2000 chars) required for `REJECT`, optional for `ACCEPT`.
- **Consent record**: The sign-off row itself serves as the immutable consent record, bound to:
  - `bast_id` → the specific BAST document
  - `event_id` → the ACCEPT/REJECT event
  - `signature_digest` → the verifiable signature
  - `evidence_record_id` → optional supporting evidence
  - `reject_reason` → only for REJECT
  - `actor_user_id` → who made the decision
  - `created_at` → when

### Immutable BAST Document Snapshot and Hash
- On each BAST status transition, a **cryptographic hash** of the BAST document state is computed and stored.
- The hash includes: `client_id`, `execution_scope_id`, `status`, `qc_run_id`, `issued_at`, `accepted_at`, `rejected_at`, `voided_at`, `created_at`, `updated_at`.
- This hash is part of the sign-off verification: the `signatureDigest` must be valid for the hash of the BAST state at the time of signing.
- **Why**: Prevents "sign-then-mutate" attacks where a signature is obtained for one BAST state, then the BAST is modified invalidating the signature.

### Server-Generated One-Time Challenge
- **Challenge flow for customer ACCEPT/REJECT**:
  1. Frontend requests a signing challenge: `GET /handyman/bast/:bastId/signing-challenge`
  2. Backend validates the actor has `tenant_company.manage` permission for the BAST's client/company.
  3. Backend generates a nonce: `crypto.randomUUID()` + `Date.now()`.
  4. Challenge payload: `{ bastId, executionScopeId, tenantPicId, nonce, expiresAt }`
  5. Backend signs this payload with its private key and returns the `challengeSignature`.
  6. Frontend presents this to the customer for signature via their e-signature tool.
  7. Customer's response: `signatureDigest = ECDSA_sign(challenge_payload_with_private_key) || PSrE_certified_signature`
  8. Backend verifies: `verify(challengeSignature, signatureDigest)` + check that `signatureDigest` covers the required fields.

### Evidence Provenance
- **ACCEPT**: Optional `evidenceRecordId` — if provided, must reference a `handyman_evidence_records` row where `execution_scope_id = bast.execution_scope_id AND client_id = bast.client_id`.
- **REJECT**: `rejectReason` is mandatory. No evidence record required, but if provided, same FK constraints apply.
- **Post-ACCEPT**: After ACCEPTED status, the system may auto-create a warranty warranty record (separate BAST concern).

### Expiration and Anti-Replay
- **Challenge nonce expiration**: 5 minutes from generation.
- **Idempotency key**: Prevents replay of the ACCEPT/REJECT request. UNIQUE on `(bast_id, event_type, idempotency_key)` in `handyman_bast_events`.
- **Single sign-off per event**: UNIQUE on `event_id` in `handyman_bast_sign_offs`. A second ACCEPT/REJECT for the same event is rejected.
- **BAST status gating**: ACCEPT only from ISSUED state; REJECT only from ISSUED state. Once ACCEPTED/REJECTED, further transitions are blocked.

### Revocation, VOID and Supersession
- **VOID**: DRAFT|ISSUED → VOID. Required `voidReason` stored in event metadata. Event history preserved.
- **Supersession**: A new BAST can be PREPARED for the same `execution_scope_id` only if the previous BAST is VOID. The unique index `handyman_bast_one_active_idx` on `(execution_scope_id) WHERE status <> 'VOID'` enforces this.
- **ACCEPT/REJECT revocation**: Not directly revocable. To reverse, the BAST must be VOIDed, a new BAST PREPARED/ ISSUED, and a new ACCEPT/REJECT obtained.

### Concurrent Decisions
- **Optimistic concurrency**: BAST UPDATE uses `WHERE id = $1 AND status = $3` (expectedFromStatus). Racing writers get 409 HANDYMAN_BAST_ILLEGAL_TRANSITION.
- **Event idempotency**: `findEventByIdempotency` prevents duplicate events. If a concurrent request has the same `idempotencyKey`, it replays the winner's event.
- **Sign-off single-writer**: UNIQUE on `event_id` ensures only one sign-off per ACCEPT/REJECT event.
- **QC gate serialization**: `lockHandymanQcScope` + `FOR UPDATE` on scope row serializes concurrent QC-dependent writes.

### Building, Client and Space Isolation
- **Building guard**: `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })` — verified in every BAST operation. The building is derived from the `handyman_execution_sopes.building_id`.
- **Client isolation**: `handyman_bast_documents` has `client_id` FK to `clients`. Triggers enforce `client_id` must match the `execution_scope_id`'s scope client.
- **Space isolation**: BAST is scoped to `execution_scope_id` which contains `floor_id`, `area_id`, `room_id`, `space_id`. Access is checked against the exact building derived from the scope.
- **No cross-client spooling**: Triggers on `handyman_bast_documents` and `handyman_bast_events` prevent client/scope identity swaps.

### Never Accept Arbitrary Browser-Supplied Hashes
- The `signatureDigest` must be **cryptographically verifiable** against a server-generated challenge.
- Raw hash strings from the browser are rejected.
- The signature must cover the challenge payload including `bastId`, `executionScopeId`, `tenantPicId`, and `nonce`.
- If using PSrE (Certified Electronic Signature), the PSrE certificate and signature must be validated through the PSrE provider's API.