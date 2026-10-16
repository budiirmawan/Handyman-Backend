# CR-HM-BAST-SIGN-00 — Trusted Customer BAST Authority Contract

## Contract Scope
This contract defines the authoritative binding chain for Customer BAST (Builders' Acceptance of Service and Terms) decisions in the Handyman Backend system. It is the single source of truth for how customer signatures are validated, how evidence is provenance'd, and how the audit trail is maintained.

## 1. Authentication Context Binding
- **Principle**: Every BAST sign-off (ACCEPT/REJECT) must be cryptographically bound to the authenticated actor's session.
- **Actor identity**: `req.auth.userId` identifies the actor in the session.
- **Tenant PIC binding**: The actor must be bound to the exact `tenant_pic_id` from the execution scope associated with the BAST.
- **No arbitrary actor**: The signature is not valid for any actor — it must be generated on behalf of the correct tenant PIC.

## 2. Exact Tenant PIC Requirement
- The BAST's `executionScope_id` references `handyman_execution_scopes`, which contains `tenant_pic_id`.
- The sign-off must be for the `tenant_pic_id` associated with the BAST's execution scope.
- **Verification**: Backend resolves the execution scope → tenant_pic_id, and verifies the actor's session is authorized for that tenant PIC.
- **Cross-client binding forbidden**: A sign-off for tenant PIC A cannot be valid for a BAST under tenant PIC B, even if both are under the same client_id.

## 3. Exact Handyman Request Binding
- The `handyman_execution_scopes` row contains `handyman_request_id`.
- The sign-off must be bound to the exact `handyman_request_id` from the execution scope.
- **Verification**: Backend checks that `bast.executionScopeId` → `executionScope_id` → `handyman_request_id` matches the request context.
- **No request-hopping**: A sign-off for handyman request A is invalid for BAST under handyman request B.

## 4. Current ISSUED BAST Status Gate
- **ACCEPT** is only valid when the BAST status is `ISSUED`.
- **REJECT** is only valid when the BAST status is `ISSUED`.
- If status is `DRAFT`, the transition is illegal (must PREPARE→ISSUE first).
- If status is `ACCEPTED` or `REJECTED`, further sign-offs are blocked (terminal states).
- If status is `VOID`, the BAST is inactivated; a new BAST must be PREPARED for the same execution_scope_id.

## 5. Explicit Decision (ACCEPT/REJECT)
- The decision is explicitly recorded in `handyman_bast_sign_offs.decision`:
  - `ACCEPT`: Customer accepts the BAST terms and initiates warranty/provisioning.
  - `REJECT`: Customer rejects the BAST terms; `rejectReason` is mandatory.
- The decision is the **sole acceptance authority** — sign-off rows are evidence, never a second status authority (governance B7).

## 6. Verifiable Evidence
- **signatureDigest**: Must be a challenge-response cryptographic signature, NOT an arbitrary hash.
  - The signature must cover the server-generated challenge payload: `{bastId, executionScopeId, tenantPicId, nonce, expiresAt}`
  - Verification: Backend validates the signature against the challenge and the stored BAST state hash.
  - If using PSrE: The PSrE certificate and signature are validated through the PSrE provider's API.
  - If using authenticated e-signature (recommended): ECDSA signature of the challenge payload.
- **evidenceRecordId**: Optional FK to `handyman_evidence_records.id`. If provided:
  - Must satisfy: `execution_scope_id = bast.execution_scope_id AND client_id = bast.client_id`
  - The evidence record must have `stage` appropriate to the BAST context (QC_EVIDENCE).
  - The evidence files must have `upload_status = 'VERIFIED'` and verified `verified_at` timestamp.
- **Never accept arbitrary browser-supplied hashes**: The `signatureDigest` is verified against the challenge payload, not accepted as proof of genuineness on its own.

## 7. Immutable Audit Trail
- **Event chain**: Every BAST operation appends to `handyman_bast_events` (PREPARE, ISSUE, VOID, ACCEPT, REJECT).
- **Idempotency**: UNIQUE constraint on `(bast_id, event_type, idempotency_key)` prevents duplicate events.
- **Sign-off binding**: UNIQUE constraint on `event_id` ensures one sign-off per ACCEPT/REJECT event.
- **Immutability triggers**:
  - BAST documents cannot be deleted (`Handyman BAST documents cannot be deleted`)
  - BAST identity (client/scope) cannot be mutated (`Handyman BAST identity (client/scope) is immutable`)
  - Events and sign-offs cannot be updated or deleted (`append-only`)
- **Audit fields always present**: `created_at`, `updated_at`, `voided_at`, `accepted_at`, `rejected_at`, `issued_at`.

## 8. Expiration and Anti-Replay
- **Challenge nonce expiration**: 5 minutes from generation. After expiry, a new challenge must be fetched.
- **Idempotency key replay prevention**: UNIQUE on `(bast_id, event_type, idempotency_key)` — duplicate keys receive the original event replay.
- **Single sign-off per event**: UNIQUE on `event_id` — second ACCEPT/REJECT for same event is rejected (409).
- **BAST status gating**: Transitions are gated by current status (ISSUED → ACCEPTED/REJECTED only).

## 9. Revocation, VOID and Supersession
- **VOID operation**: DRAFT|ISSUED → VOID. Required `voidReason` stored in event metadata (`metadata.voidReason`).
  - Event history is never deleted.
  - The unique index on `(execution_scope_id) WHERE status <> 'VOID'` allows a new BAST to be PREPARED for the same scope.
- **Supersession**: A new BAST PREPARED for an execution_scope_id where the previous BAST is VOID. The new BAST starts at DRAFT.
- **ACCEPT/REJECT reversal**: Not directly reversible. To reverse, the BAST must be VOIDed, a new BAST PREPARED/ ISSUED, and a new ACCEPT/REJECT obtained.

## 10. Concurrent Decision Handling
- **Optimistic concurrency**: BAST UPDATE uses `WHERE id = $1 AND status = $3`. Racing writers get 409 HANDYMAN_BAST_ILLEGAL_TRANSITION.
- **Event idempotency**: `findEventByIdempotency` prevents duplicate events. Concurrent requests with same idempotencyKey replay the winner.
- **Sign-off single-writer**: UNIQUE on `event_id` ensures only one sign-off per ACCEPT/REJECT event.
- **QC gate serialization**: `lockHandymanQcScope` + `FOR UPDATE` on scope row serializes concurrent QC-dependent writes.

## 11. Building, Client and Space Isolation
- **Building guard**: `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })` is mandatory in every BAST operation. The building is derived from the execution scope.
- **Client isolation**: `handyman_bast_documents.client_id` FK to `clients`. Triggers enforce `client_id` must match the execution scope's client.
- **Space isolation**: BAST is scoped to `execution_scope_id` which contains `floor_id`, `area_id`, `room_id`, `space_id`. Access is checked against the exact building.
- **No cross-client spooling**: Triggers on `handyman_bast_documents` and `handyman_bast_events` prevent client/scope identity swaps.

## 12. PSrE Consideration
- **Do not assume PSrE is unnecessary for every customer contract**.
- PSrE (Certified Electronic Signature) provides the highest legal standing under Indonesian law (uu No. 11/2020).
- The recommended minimum secure model (Option A) uses authenticated electronic approval WITHOUT PSrE for standard handyman contracts.
- PSrE should be offered as an option for high-value contracts, government projects, or where explicitly required by policy.
- The system must support BOTH options: authenticated e-signature (default) and PSrE (optional per-contract policy).



## 14. Building Customer Care Handoff Model (CR-HM-BM-CARE-HANDOFF-01 Correction)

This section formalizes the CR-HM-BM-CARE-HANDOFF-01 business correction, ensuring the
Authority Contract explicitly documents the correct mediation model and its constraints.

### Model: TENANT / TENANT PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN

The authoritative mediation chain for care decisions is not a direct Tenant→Handyman path,
but a Building Customer Care–bridged flow with strict separation of roles:

1. **Customer Care Building is the primary operational communication bridge**.
   The Building Customer Care actor serves as the official communication bridge between
   the Tenant/PIC and the Handyman system. All care-mediated interactions MUST pass
   through the Building Customer Care layer — no direct Tenant Handyman login is required
   or permitted for care decision recording.

2. **The Tenant does not require a direct Handyman account**.
   Tenant/PIC participants in the care flow do not need individual Handyman accounts or
   credentials. The Building Customer Care actor authenticates via backend session, and
   the Tenant's role is limited to providing decision evidence through the Building's
   mediated channel.

3. **The authenticated recording actor is Building Customer Care; the actual decision maker is Tenant/PIC**.
   Identity separation is enforced at every layer:
   - The `recordedByUserId` in care decision records reflects the authenticated Backend
     session (Building Customer Care), NOT any value supplied in the request body.
   - The actual Tenant/PIC decision is evidenced by the single-use BM Super App
     exchange token hash (`evidence_exchange_token_hash`), which binds the decision
     to the real Tenant/PIC without requiring Tenant login to Handyman.
   - Care cannot impersonate Tenant (exchange token binding prevents this).

4. **A BM handoff exchange token does not prove Tenant approval**.
   The exchange token hash stored in the decision record is a provenance identifier —
   it records which token was consumed, but it does NOT by itself constitute proof that
   the Tenant approved a quotation, variation, or BAST. The token is a single-use,
     one-time consumption event for handoff attribution; decision evidence and its
     verification status are separate from the token's operational purpose.

5. **BAST ACCEPT, quotation approval and variation approval require verifiable decision provenance,
   which is still an unresolved authority contract**.
   Even when a Care decision record is created (CONFIRM or REJECT), this does not
   automatically trigger: quotation APPROVE, variation APPROVE, or BAST ACCEPT.
   Each commercial decision requires its own verifiable provenance chain. The authority
     contract for what constitutes valid decision provenance for commercial operations
     remains explicitly unresolved and must be decided per product policy. Care decision
     records are neutrally recorded — they are NOT a signal to approve related commercial
     entities. This is a fail-closed design: without explicit product authority, the
     mutation is blocked.

### Identity Separation Invariants

- `client_id` in care decisions is derived from the execution scope, not from request body
- `execution_scope_id` must exist and belong to the client — validated by service
- Exactly-one-target constraint: (bast_id IS NOT NULL XOR service_request_id IS NOT NULL)
  via partial UNIQUE INDEX — never both, never neither
- Decision identity (client_id, execution_scope_id, tenant_pic_id) is immutable once written
  — UPDATE/DELETE blocked at DB level by four triggers
- `evidence_exchange_token_hash` stores the token hash for audit provenance only
  — NOT treated as Tenant approval proof
- `recorded_by_user_id` FK to users is derived from authenticated Backend session;
  request body value is NOT trusted

### Decision Provenance Separation

Each care decision records:
- The decision itself (CONFIRM/REJECT)
- The execution scope binding
- The exchange token hash for provenance
- The recording actor (Building Customer Care, from session)
- The actual Tenant/PIC decision context (evidenced, not assumed)

Commercial mutations (quotation APPROVE, variation APPROVE, BAST ACCEPT) are
  explicitly separate. A care decision record alone does not authorize any commercial
  state change. The system is fail-closed: if product authority for commercial mutations
  is not explicitly granted, the write route remains blocked and the decision stays
  in PENDING_VERIFICATION state without further propagation.
## 13. Summary of Binding Chain
```
Authenticated User → Exact Tenant PIC → Exact Handyman Request → 
Current ISSUED BAST → Explicit Decision (ACCEPT/REJECT) → 
Verifiable Evidence (signatureDigest + optional evidenceRecordId) → 
Immutable Audit (event chain + sign-off)
```