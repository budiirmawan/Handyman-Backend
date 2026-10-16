# CR-HM-BAST-SIGN-00 — Conceptual Data Model and Required Migrations

## Existing Tables (REUSE — no changes needed to table structure, only trigger/constraint validation)

### 5.1 handyman_bast_documents
| Column | Type | Purpose | Reuse |
|---|---|---|---|
| id UUID PK | Primary key | BAST document unique identifier | ✅ Reuse |
| client_id UUID FK → clients | Client binding | Must match execution scope client (trigger enforcement) | ✅ Reuse |
| execution_scope_id UUID FK → handyman_execution_scopes | Scope binding | Unique index on (execution_scope_id) WHERE status <> 'VOID' | ✅ Reuse |
| status TEXT CHECK (DRAFT/ISSUED/ACCEPTED/REJECTED/VOID) | Status vocabulary | Full frozen set enforced by CHECK constraint | ✅ Reuse |
| issued_at TIMESTAMPTZ | ISSUE timestamp | NULL allowed for DRAFT; required for ISSUED (trigger check) | ✅ Reuse |
| voided_at TIMESTAMPTZ | VOID timestamp | NULL allowed unless status = 'VOID' (trigger check) | ✅ Reuse |
| created_at TIMESTAMPTZ | Creation audit | DEFAULT NOW() | ✅ Reuse |
| updated_at TIMESTAMPTZ | Last-update audit | DEFAULT NOW() | ✅ Reuse |

**Triggers (REUSE)**:
- `handyman_bast_client_check`: client_id must match scope client
- `handyman_bast_identity_guard`: client/scope immutable on UPDATE/DELETE
- `handyman_bast_head_identity_guard`: prevents client/scope swap
- `handyman_bast_events_no_write`: events cannot be UPDATE/DELETE

### 5.2 handyman_bast_events
| Column | Type | Purpose | Reuse |
|---|---|---|---|
| id UUID PK | Event unique identifier | ✅ Reuse |
| client_id UUID FK → clients | Client consistency | Trigger-enforced consistency with parent BAST | ✅ Reuse |
| bast_id UUID FK → handyman_bast_documents | Parent BAST | Trigger-enforced parent consistency | ✅ Reuse |
| execution_scope_id UUID FK → handyman_execution_scopes | Scope consistency | Trigger-enforced parent scope | ✅ Reuse |
| event_type TEXT CHECK (PREPARE/ISSUE/VOID/ACCEPT/REJECT) | Event vocabulary | Extended from PART 01 to include PART 02 | ✅ Reuse |
| idempotency_key TEXT | Idempotency boundary | UNIQUE on (bast_id, event_type, idempotency_key) | ✅ Reuse |
| actor_user_id UUID FK → users | Who performed the action | ✅ Reuse |
| occurred_at TIMESTAMPTZ | When event occurred | DEFAULT NOW() | ✅ Reuse |
| created_at TIMESTAMPTZ | Audit creation | DEFAULT NOW() | ✅ Reuse |
| metadata JSONB | Append-only audit extras | Default '{}'; worker VOID stores {voidReason} | ✅ Reuse |

**Triggers (REUSE)**:
- `handyman_bast_events_parent_check`: event must match parent document client/scope/bast
- `handyman_bast_events_no_write`: events cannot be UPDATE/DELETE

### 5.3 handyman_bast_sign_offs
| Column | Type | Purpose | Reuse |
|---|---|---|---|
| id UUID PK | Sign-off unique identifier | ✅ Reuse |
| client_id UUID FK → clients | Client binding | ✅ Reuse |
| bast_id UUID FK → handyman_bast_documents | Parent BAST | ✅ Reuse |
| event_id UUID FK → handyman_bast_events | Parent event | UNIQUE on event_id | ✅ Reuse |
| execution_scope_id UUID FK → handyman_execution_scopes | Scope binding | ✅ Reuse |
| decision TEXT CHECK (ACCEPT/REJECT) | Decision type | ✅ Reuse |
| signature_digest TEXT | Cryptographic signature | Currently: length check only; MUST be enhanced | ⚠️ Enhance |
| evidence_record_id UUID FK → handyman_evidence_records | Optional evidence | ✅ Reuse (FK constraints) |
| reject_reason TEXT | rejection reason | Mandatory for REJECT, NULL for ACCEPT | ✅ Reuse |
| created_at TIMESTAMPTZ | Sign-off creation | DEFAULT NOW() | ✅ Reuse |

**Triggers (REUSE)**:
- `handyman_bast_sign_off_parent_check`: sign-off must match event parent client/scope/bast
- `handyman_bast_sign_offs_no_write`: sign-off rows cannot be UPDATE/DELETE

## New / Augmented Model Elements

### 6.1 handyman_bast_documents enhancements

#### New column: `state_hash`
- **Type**: TEXT (nullable for historical BASTs; filled on first transition)
- **Purpose**: Cryptographic hash of the BAST document state at a given moment. Used for signature binding verification.
- **Hash content**: `sha256(client_id || execution_scope_id || status || qc_run_id || issued_at || accepted_at || rejected_at || voided_at || created_at || updated_at)`
- **Population**: Computed and stored on every status transition via the `updateBastStatus` function or an additional trigger.
- **Why**: Prevents "sign-then-mutate" attacks. A signature is only valid for the BAST state hash at the time of signing.

**Required migration**: Add `state_hash` column with DEFAULT NULL, then add trigger or application logic to compute and store hash on each transition.

### 6.2 Enhanced signature_digest validation

#### Current state:
- `signatureDigest` stored as TEXT, max 512 chars
- `assertHandymanBastSignature` only checks: non-empty for ACCEPT, length <= 512
- **No cryptographic verification** — arbitrary browser-supplied strings accepted

#### Required enhancement:
The `signatureDigest` must be verifiable against:
1. The server-generated challenge nonce
2. The BAST state hash at signing time
3. The tenant PIC from the execution scope

**New validation logic** (replacing `assertHandymanBastSignature`):
```
function verifyHandymanBastSignature(signatureDigest, challengeNonce, bastStateHash, tenantPicId):
  1. If action === 'ACCEPT' and signatureDigest is empty → error
  2. If signatureDigest length > 512 → error
  3. Verify signatureDigest covers: {bastId, executionScopeId, tenantPicId, challengeNonce, bastStateHash}
  4. Verification method depends on signature mode:
     a) ECDSA: verify(publicKey, message=challengePayload, signature=signatureDigest)
     b) PSrE: validate through PSrE provider API
  5. If verification fails → error (signature not from authorized signatory)
  6. Return raw signatureDigest (trimmed) for storage
```

**Required migration**: No DB schema change needed; update the validation logic in `handyman-bast.service.ts` and `handyman-bast-api.validation.ts`.

### 6.3 Challenge nonce tracking (new table or columns)

Option A: Add columns to `handyman_bast_sign_offs`
- `challenge_nonce TEXT` — the nonce value used for signature generation (stored for audit, NOT for verification on every read)
- `challenge_expires_at TIMESTAMPTZ` — when the nonce expired
- `bast_state_hash_at_signing TEXT` — the state hash the signature was computed over

Option B: New table `handyman_bast_signature_challenges`
- id UUID PK
- bast_id UUID FK → handyman_bast_documents
- challenge_nonce TEXT
- challenge_payload JSONB (contains bastId, executionScopeId, tenantPicId, nonce, expiresAt)
- challenge_signature TEXT (server's sign of the payload, for verification)
- created_at TIMESTAMPTZ DEFAULT NOW()
- Used for: challenge generation, verification, and audit

**Recommendation**: Option A (add columns to sign_offs) is simpler and sufficient. The nonce is stored for audit; verification uses the current challenge flow (frontend fetches fresh nonce, signs, submits). The stored nonce is only needed for replay forensics.

**Required migration**: Add `challenge_nonce`, `challenge_expires_at`, `bast_state_hash_at_signing` columns to `handyman_bast_sign_offs`. Or create `handyman_bast_signature_challenges` table.

### 6.4 Index and constraint updates

**New constraint on sign-offs**:
```sql
-- Extended check: signature_digest must be challenge-verifiable
-- This is enforced in application logic, not DB-level check (too complex for SQL)
-- But we add a comment/documented constraint:
CONSTRAINT handyman_bast_sign_off_signature_challenge_check
  CHECK (action = 'REJECT' 
    OR (action = 'ACCEPT' AND length(signature_digest) > 0 
        AND signature_digest IS NOT NULL))
```

**Updated unique index consideration**:
The existing `handyman_bast_sign_offs_event_idx ON handyman_bast_sign_offs (event_id)` already prevents duplicate sign-offs. No change needed.

## Migration Summary

| Migration ID | Description | Priority |
|---|---|---|
| 0404+ (existing) | handyman_bast_documents, events, sign_offs | ✅ Already exists |
| 0405 (existing) | accepted_at, rejected_at, sign-off table | ✅ Already exists |
| 0445 (existing) | QC run provenance binding | ✅ Already exists |
| **NEW: Add state_hash to handyman_bast_documents** | Compute hash on each status transition | **High** |
| **NEW: Enhance signature_digest validation** | Challenge-response verification replacing bare-hash acceptance | **High** |
| **NEW: Add challenge_nonce / bast_state_hash_at_signing to sign_offs** | Track challenge metadata for audit and replay forensics | **Medium** |
| **NEW: Update assertion functions** | Replace assertHandymanBastSignature with full verification logic | **High** |

**No breaking changes**: All new columns are ADDITIONAL (nullable with DEFAULT), no existing columns are modified or removed. Triggers are added/updated in application logic, not removing existing DB guarantees.