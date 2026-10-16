# CR-HM-BAST-SIGN-00 — API Request/Response Proposals

## API Surface Summary
All endpoints require authentication (`authenticationMiddleware`). Customer sign-off requires `tenant_company.manage` permission. Worker BAST commands use separate worker API (`handyman-bast-worker-api`) with `handyman.bast.manage`.

---

### 1. GET /handyman/bast/:bastId

**Description**: Retrieve BAST detail with acceptance status, events, and sign-offs for a specific BAST ID.

**Security**: Requires `tenant_company.read` + `assertBuildingScopedResourceAccess`

**Success Response (200)**:
```json
{
  "bast": {
    "id": "string (UUID)",
    "executionScopeId": "string (UUID)",
    "qcRunId": "string (UUID) | null",
    "status": "DRAFT | ISSUED | ACCEPTED | REJECTED | VOID",
    "issuedAt": "ISO8601 timestamp | null",
    "acceptedAt": "ISO8601 timestamp | null",
    "rejectedAt": "ISO8601 timestamp | null",
    "voidedAt": "ISO8601 timestamp | null",
    "createdAt": "ISO8601 timestamp",
    "updatedAt": "ISO8601 timestamp",
    "artifact": {
      "ref": "string (versioned artifact reference)",
      "version": "string"
    },
    "availableActions": ["PREPARE" | "ISSUE" | "VOID" | "ACCEPT" | "REJECT"] // computed from status
  },
  "acceptance": {
    "bastId": "string (UUID)",
    "executionScopeId": "string (UUID)",
    "status": "DRAFT | ISSUED | ACCEPTED | REJECTED | VOID",
    "customerAccepted": boolean,
    "warrantyStartEligible": boolean,
    "issuedAt": "ISO8601 timestamp | null",
    "acceptedAt": "ISO8601 timestamp | null",
    "rejectedAt": "ISO8601 timestamp | null",
    "voidedAt": "ISO8601 timestamp | null",
    "artifactRef": "string (artifact reference) | null",
    "approvedSignOff": {
      "signOffId": "string (UUID)",
      "eventId": "string (UUID)",
      "signatureDigest": "string (trimmed, verified)",
      "evidenceRecordId": "string (UUID) | null",
      "actorUserId": "string (UUID)",
      "occurredAt": "ISO8601 timestamp",
      "createdAt": "ISO8601 timestamp"
    } | null,
    "signOffComplete": boolean
  },
  "events": [
    {
      "id": "string (UUID)",
      "bastId": "string (UUID)",
      "executionScopeId": "string (UUID)",
      "eventType": "PREPARE | ISSUE | VOID | ACCEPT | REJECT",
      "idempotencyKey": "string (1-200 chars)",
      "actorUserId": "string (UUID)",
      "occurredAt": "ISO8601 timestamp",
      "createdAt": "ISO8601 timestamp",
      "voidReason": "string | null" // CR-HM-BAST-HTTP-01: worker VOID reason
    }
  ],
  "signOffs": [
    {
      "id": "string (UUID)",
      "bastId": "string (UUID)",
      "eventId": "string (UUID)",
      "executionScopeId": "string (UUID)",
      "decision": "ACCEPT | REJECT",
      "signatureDigest": "string (trimmed, verified)",
      "evidenceRecordId": "string (UUID) | null",
      "rejectReason": "string (2000 chars max) | null",
      "createdAt": "ISO8601 timestamp"
    }
  ]
}
```

**Error Responses**:
- 404: `handymanBastNotFoundError` — bastId does not exist
- 403: Access denied — building guard failed

---

### 2. GET /handyman/execution-scopes/:executionScopeId/bast

**Description**: Retrieve BAST detail scoped to an execution scope.

**Security**: Requires `tenant_company.read` + `assertBuildingScopedResourceAccess`

**Success Response (200)**:
```json
{
  "executionScopeId": "string (UUID)",
  "bast": { /* same as GET /bast/:bastId bast */ } | null,
  "acceptance": { /* same as GET /bast/:bastId acceptance */ } | null,
  "events": [...] // same event format as GET /bast/:bastId
  "signOffs": [...] // same sign-off format as GET /bast/:bastId
}
```

**Error Responses**: Same as GET /handyman/bast/:bastId

---

### 3. POST /handyman/bast/:bastId/accept

**Description**: Customer ACCEPT — transition BAST from ISSUED to ACCEPTED.

**Security**: Requires `tenant_company.manage` + challenge-response signature verification

**Request Body**:
```json
{
  "idempotencyKey": "string",          // required, 1-200 characters, trimmed
  "signatureDigest": "string",          // required — challenge-response signature, trimmed, max 512 chars
  "evidenceRecordId": "string | null",  // optional UUID — if provided must match bast's execution_scope_id and client_id
  "rejectReason": "string | null"       // must NOT be present for ACCEPT (will cause validation error)
}
```

**Success Response (200)**:
```json
{
  "bast": { /* updated BAST payload */ },
  "acceptance": {
    "bastId": "string (UUID)",
    "executionScopeId": "string (UUID)",
    "status": "ACCEPTED",
    "customerAccepted": true,
    "warrantyStartEligible": boolean,
    "issuedAt": "ISO8601 timestamp",
    "acceptedAt": "ISO8601 timestamp (now)",
    "rejectedAt": null,
    "voidedAt": null,
    "artifactRef": "string (artifact reference)",
    "approvedSignOff": {
      "signOffId": "string (UUID)",
      "eventId": "string (UUID)",
      "signatureDigest": "string (verified)",
      "evidenceRecordId": "string (UUID) | null",
      "actorUserId": "string (UUID)",
      "occurredAt": "ISO8601 timestamp",
      "createdAt": "ISO8601 timestamp"
    },
    "signOffComplete": true
  },
  "event": {
    "id": "string (UUID)",
    "bastId": "string (UUID)",
    "executionScopeId": "string (UUID)",
    "eventType": "ACCEPT",
    "idempotencyKey": "string",
    "actorUserId": "string (UUID)",
    "occurredAt": "ISO8601 timestamp",
    "createdAt": "ISO8601 timestamp",
    "voidReason": null
  },
  "signOff": {
    "id": "string (UUID)",
    "bastId": "string (UUID)",
    "eventId": "string (UUID)",
    "executionScopeId": "string (UUID)",
    "decision": "ACCEPT",
    "signatureDigest": "string (verified)",
    "evidenceRecordId": "string (UUID) | null",
    "rejectReason": null,
    "createdAt": "ISO8601 timestamp"
  }
}
```

**Error Responses**:
- 400: `handymanBastSignatureRequiredError` — empty signatureDigest for ACCEPT
- 400: Validation error — signatureDigest not challenge-verifiable, or evidenceRecordId doesn't match execution_scope_id/client_id
- 409: `handymanBastIllegalTransitionError` — BAST not in ISSUED status
- 409: Idempotency conflict — same idempotencyKey already used for ACCEPT/REJECT on this BAST
- 403: Building guard failed — actor not authorized for this BAST's building

---

### 4. POST /handyman/bast/:bastId/reject

**Description**: Customer REJECT — transition BAST from ISSUED to REJECTED.

**Security**: Requires `tenant_company.manage` + challenge-response signature verification + mandatory rejectReason

**Request Body**:
```json
{
  "idempotencyKey": "string",          // required, 1-200 characters, trimmed
  "signatureDigest": "string",          // required — challenge-response signature, trimmed, max 512 chars
  "evidenceRecordId": "string | null",  // optional UUID — if provided must match bast's execution_scope_id and client_id
  "rejectReason": "string"              // required, trimmed, max 2000 characters
}
```

**Success Response (200)**: Same structure as POST /accept success response, but with `decision: "REJECT"` and `signOff.rejectReason` populated.

**Error Responses**:
- 400: Validation error — empty rejectReason, signatureDigest not challenge-verifiable, or evidenceRecordId doesn't match
- 409: `handymanBastIllegalTransitionError` — BAST not in ISSUED status
- 409: Idempotency conflict — same idempotencyKey already used
- 403: Building guard failed

---

### 5. GET /handyman/bast/:bastId/signing-challenge (NEW)

**Description**: Generate a one-time signing challenge for customer ACCEPT/REJECT.

**Security**: Requires `tenant_company.manage` — validates actor has permission for the BAST's client/company

**Success Response (200)**:
```json
{
  "challenge": {
    "nonce": "string (UUID v4)",         // one-time use, single-use only
    "expiresAt": "ISO8601 timestamp",    // typically 5 minutes from generation
    "payloadStructure": {
      "bastId": "string (UUID)",
      "executionScopeId": "string (UUID)",
      "tenantPicId": "string (UUID)",
      "nonce": "string (UUID v4)",
      "expiresAt": "ISO8601 timestamp"
    }
  },
  "challengeSignature": "string"          // server's private-key signature of the payload JSON
}
```

**Verification flow**:
1. Frontend receives challenge payload structure
2. Frontend presents to customer: "Please sign the following payload with your e-signature tool:"
3. Customer signs via e-signature tool (ECDSA or PSrE)
4. Frontend returns `signatureDigest` = the raw signature string from the e-signature tool
5. Backend verifies: `signatureDigest` covers the challenge payload + matches the `challengeSignature` verification

**Error Responses**:
- 403: Access denied — actor not authorized for this BAST's client/company

---

### 6. POST /handyman/bast/:bastId/verify-signature (INTERNAL)

**Description**: Internal endpoint to verify a submitted signature against a challenge nonce. Used by the backend service layer.

**Security**: Internal — not exposed to external callers directly; called from service layer

**Request Body**:
```json
{
  "signatureDigest": "string",          // the signature submitted by the customer
  "challengeNonce": "string",           // the nonce from the signing challenge
  "bastId": "string (UUID)",            // the BAST being signed
  "executionScopeId": "string (UUID)", // the execution scope
  "tenantPicId": "string (UUID)",      // the tenant PIC from the scope
  "bastStateHash": "string"            // the BAST state hash at signing time
}
```

**Success Response (200)**:
```json
{
  "valid": true
}
```

**Error Response (400/401)**:
```json
{
  "valid": false,
  "reason": "challenge_expired | signature_mismatch | tenant_pic_mismatch | invalid_payload_format"
}
```

**Verification logic**:
1. Check `challengeNonce` has not expired (current time < challenge `expiresAt`)
2. Reconstruct the challenge payload: `{bastId, executionScopeId, tenantPicId, nonce, expiresAt}`
3. Verify `signatureDigest` is a valid cryptographic signature of the payload:
   - If ECDSA: recover public key from the authenticated session's tenant PIC; verify against payload
   - If PSrE: call PSrE provider API to validate the certificate and signature
4. Check that `tenantPicId` matches the execution scope's tenant PIC
5. Check that `bastStateHash` matches the current BAST document state hash
6. If all checks pass → `valid: true`; otherwise → `valid: false` with specific reason

**Error Responses**:
- 400: `challenge_expired` — nonce past expiry
- 401: `signature_mismatch` — signature doesn't verify against payload
- 401: `tenant_pic_mismatch` — tenant PIC in signature doesn't match scope
- 400: `invalid_payload_format` — signatureDigest doesn't cover required fields