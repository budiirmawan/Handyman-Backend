# CR-HM-BAST-SIGN-00 — Exact Frontend Handoff Requirements

## Overview
This document specifies the exact frontend changes required to support the trusted customer BAST authority model. All changes are frontend-only; no mobile or operations changes are needed.

---

## 1. New API Endpoints

### 1.1 GET /handyman/bast/:bastId/signing-challenge (NEW)

**Purpose**: Fetch a one-time signing challenge for customer ACCEPT/REJECT.

**Request**:
- Method: GET
- Path: `/handyman/bast/:bastId/signing-challenge`
- Headers: `Authorization: Bearer <token>` (valid session with `tenant_company.manage`)
- Params: `bastId` (UUID path parameter)

**Success Response (200)**:
```json
{
  "challenge": {
    "nonce": "ui-6dvw5a2x-qrpl4gcY=",  // example UUID v4 string
    "expiresAt": "2026-01-15T10:30:00Z",  // ISO8601, ~5 min from now
    "payloadStructure": {
      "bastId": "ba-9f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",
      "executionScopeId": "es-3f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",
      "tenantPicId": "tp-3f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",
      "nonce": "ui-6dvw5a2x-qrpl4gcY=",
      "expiresAt": "2026-01-15T10:30:00Z"
    }
  },
  "challengeSignature": "{\"signatures\":{\"ecdsap256\":\"MEUCIQD...\"}}"  // server's sign of payload JSON
}
```

**Error Responses**:
- 403: `{"error": "forbidden", "message": "Access denied - not authorized for this BAST"}` — actor not authorized for this BAST's client/company

**Frontend Behavior**:
1. On open BAST detail page, show "Accept"/ "Reject" button disabled until challenge is fetched
2. Fetch challenge immediately on page load (or when user clicks accept/reject)
3. Display challenge to customer:
   ```
   Please sign the following payload with your e-signature tool:
   
   {
     "bastId": "ba-9f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",
     "executionScopeId": "es-3f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",
     "tenantPicId": "tp-3f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",
     "nonce": "ui-6dvw5a2x-qrpl4gcY=",
     "expiresAt": "2026-01-15T10:30:00Z"
   }
   ```
4. Enable customer's e-signature tool to sign this payload
5. Capture the `signatureDigest` from the signature output
6. Submit ACCEPT/REJECT with the `signatureDigest`

---

### 1.2 POST /handyman/bast/:bastId/accept (MODIFIED)

**Purpose**: Customer submits ACCEPT with challenge-response signature.

**Request Body** (JSON):
```json
{
  "idempotencyKey": "unique-key-123",          // required, client-generated or server-generated UUID
  "signatureDigest": "MEUCIQD...",              // required — output from customer's e-signature tool
  "evidenceRecordId": "ev-3f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",  // optional UUID
  "rejectReason": null                           // must NOT be included for ACCEPT
}
```

**Frontend Requirements**:
- `idempotencyKey`: Generate a unique key (e.g., UUID v4) per sign-off attempt. Store locally to prevent double-submit on page refresh.
- `signatureDigest`: The raw signature string from the customer's e-signature tool (ECDSA base64url or PSrE-certified signature).
- `evidenceRecordId`: Optional. If the customer has uploaded supporting evidence, provide the evidence record UUID. Must match the BAST's `execution_scope_id` and `client_id`.
- `rejectReason`: MUST NOT be included in the body for ACCEPT. Including it may cause validation error.

**Success Response (200)**: Updated BAST detail with `status: "ACCEPTED"`, acceptance payload, and sign-off displayed.

**Error Responses**:
- 400: `{"error": "bad_request", "message": "signatureDigest is required for ACCEPT"}` — empty signatureDigest
- 400: `{"error": "bad_request", "message": "signature verification failed - challenge mismatch"}` — signature doesn't verify against challenge
- 409: `{"error": "conflict", "message": "BAST is not in ISSUED status"}` — BAST must be ISSUED to accept
- 409: `{"error": "conflict", "message": "Idempotency key already used"` — same key already processed
- 403: `{"error": "forbidden", "message": "Building access denied"}` — actor not in correct building

---

### 1.3 POST /handyman/bast/:bastId/reject (MODIFIED)

**Purpose**: Customer submits REJECT with challenge-response signature and rejection reason.

**Request Body** (JSON):
```json
{
  "idempotencyKey": "unique-key-456",
  "signatureDigest": "MEUCIQD...",
  "evidenceRecordId": "ev-3f8b2e4d-6c3a-4f2a-8d1e-7f2a3b4c5d6e",  // optional
  "rejectReason": "The work scope does not match the agreed contract."  // REQUIRED, trimmed max 2000 chars
}
```

**Frontend Requirements**:
- `rejectReason` text input is **mandatory** — the form cannot be submitted without it.
- `signatureDigest`: Same as ACCEPT — output from customer's e-signature tool.
- `evidenceRecordId`: Optional, same rules as ACCEPT.
- `idempotencyKey`: Unique per attempt.

**Success Response (200)**: Updated BAST detail with `status: "REJECTED"`, sign-off with `decision: "REJECT"` and `rejectReason` populated.

**Error Responses**:
- 400: `{"error": "bad_request", "message": "rejectReason is required for REJECT"}` — empty or missing rejectReason
- 400: `{"error": "bad_request", "message": "signature verification failed"}` — signature doesn't verify
- 409: `{"error": "conflict", "message": "BAST is not in ISSUED status"}` — BAST must be ISSUED to reject
- 409: `{"error": "conflict", "message": "Idempotency key already used"}` — duplicate key

---

## 2. Component Changes

### 2.1 BAST Detail Page (`/handyman/bast/:bastId`)

**Existing display (unchanged)**:
- BAST status badge (DRAFT/ISSUED/ACCEPTED/REJECTED/VOID)
- Dates (issuedAt, acceptedAt, rejectedAt, voidedAt)
- Artifact reference and version
- Event history (PREPARE/ISSUE/VOID events)

**New display additions**:
1. **Acceptance status section**:
   - Show current: "Pending", "Accepted", or "Rejected"
   - If pending: Show "Accept" and "Reject" call-to-action buttons
   - If accepted/rejected: Show who accepted/rejected, when, and the sign-off audit

2. **Sign-off audit panel** (shown for ACCEPTED/REJECTED BASTs):
   - "Signed by: [actor name/timestamp]"
   - "Decision: ACCEPT/REJECT"
   - "Signature: verified" / "Signature: pending verification"
   - "Evidence: linked" / "Evidence: none" (with link if present)
   - "Rejection reason: [text]" (only for REJECT)

3. **Challenge status indicator** (shown when ACCEPT/REJECT is pending):
   - "Challenge fetched: expires in X minutes"
   - "Please sign the payload above with your e-signature tool"

### 2.2 Accept/Reject Modal (NEW or MODAL OVERLAY)

**Trigger**: User clicks "Accept" or "Reject" on the BAST detail page.

**Modal Flow**:
1. **Fetch challenge**: Immediately call `GET /handyman/bast/:bastId/signing-challenge`
   - Show spinner while fetching
   - On 403: Show "You don't have access to this BAST" and disable buttons
   - On error: Show error and keep modal closed

2. **Display challenge payload**:
   - Show expandable JSON box with the payloadStructure
   - Show expiry timer: "Expires in 5:00" counting down from `expiresAt - now`
   - "Copy to clipboard" button for the payload

3. **E-signature tool integration**:
   - Customer clicks "Sign Payload" → opens their e-signature tool (web widget or native app)
   - Tool presents the payload JSON for signing
   - Customer signs (draws, selects certificate, or uses organizational SSO e-signature)
   - Tool returns `signatureDigest` (base64url-encoded ECDSA signature or PSrE-certified signature)

4. **Submit sign-off**:
   - Customer clicks "Submit Accept" or "Submit Reject"
   - Frontend constructs request body with:
     - `idempotencyKey` (from step 1 or generated fresh)
     - `signatureDigest` (from e-signature tool)
     - `evidenceRecordId` (optional, from evidence linking)
     - For REJECT: `rejectReason` text value
   - POST to `/handyman/bast/:bastId/accept` or `/handyman/bast/:bastId/reject`
   - Show loading spinner
   - On success: Close modal, refresh BAST detail, show success toast
   - On error: Display error message from backend (signature verification failed, QC not ready, building access denied, etc.)
   - On 409 (idempotency conflict): Show "Your request has already been processed" and refresh

### 2.3 Idempotency Key Management

- **Generation**: Frontend generates UUID v4 on modal open, stores in localStorage/sessionStorage keyed by `bastId`
- **Reuse**: On modal re-open (same session), reuse the same key if still valid (not yet processed)
- **Collision avoidance**: If the generated key already exists in the system (rare), the backend returns 409, and the frontend regenerates

### 2.4 Error Handling UI

| Error Scenario | UI Message | Action |
|---|---|---|
| Challenge fetch 403 | "You don't have access to this BAST" | Disable Accept/Reject buttons |
| Challenge fetch other error | "Unable to fetch signing challenge. Try again." | Retry button |
| Signature verification failed | "Signature verification failed. Please check your e-signature tool and try again." | Retry (re-fetch challenge, re-sign) |
| QC not ready | "Quality check not complete. Wait for inspection to pass." | Inform user; BAST must have current QC PASS |
| Building access denied | "You don't have access to this BAST." | Disable buttons; different building assignment |
| Idempotency conflict | "Your request has already been processed. The BAST status remains unchanged." | Inform user; no further action needed |
| Empty rejectReason (REJECT only) | "Rejection reason is required. Please provide a reason." | Highlight text input, prevent submit |
| Signature too long | "Signature is too long. Please use a valid e-signature output." | Inform user; check e-signature tool output |
| Nonce expired | "Signing challenge has expired. Please refresh the BAST detail and try again." | Re-fetch challenge, re-sign |

---

## 3. State Management

### 3.1 Local Frontend State

```typescript
interface BastDetailState {
  bast: BastRecord;
  acceptance: AcceptanceRecord | null;
  events: EventRecord[];
  signOffs: SignOffRecord[];
  challenge: ChallengeRecord | null;  // fetched from /signing-challenge
  isFetchingChallenge: boolean;
  isSubmittingSignOff: boolean;
  signOffError: string | null;
  idempotencyKey: string;  // generated once per modal open
  rejectReason: string;  // model for REJECT form input
  showRejectReasonError: boolean;
}
```

### 3.2 Flow State Transitions

1. **Page load** → fetch BAST detail → fetch challenge → display
2. **User clicks Accept** → fetch challenge (if not already) → present payload → sign → submit ACCEPT
3. **User clicks Reject** → fetch challenge (if not already) → present payload → sign → provide rejectReason → submit REJECT
4. **On sign-off success** → update local state with new acceptance status → refresh from API → show toast
5. **On sign-off error** → display error → allow retry (re-fetch challenge, re-sign)

### 3.3 Error State Recovery

- **Challenge expired**: Re-fetch challenge from API, re-present payload, re-sign
- **Network error**: Show transient error; allow retry button
- **Unexpected error**: Log to console; show generic "Something went wrong. Please try again." — allow 2 retries before giving up

---

## 4. API Integration Checklist for Frontend Team

### 4.1 New Endpoints to Implement
- [ ] `GET /handyman/bast/:bastId/signing-challenge` — fetch challenge nonce and payload structure
- [ ] `POST /handyman/bast/:bastId/accept` — submit ACCEPT with signature (same path, enhanced validation)
- [ ] `POST /handyman/bast/:bastId/reject` — submit REJECT with signature and reason (same path, enhanced validation)

### 4.2 Existing Endpoints (No Changes Needed)
- [ ] `GET /handyman/bast/:bastId` — fetch BAST detail (unchanged response format, just new fields may appear)
- [ ] `GET /handyman/execution-scopes/:executionScopeId/bast` — fetch by execution scope (unchanged)

### 4.3 Authentication
- [ ] All new/modified endpoints require `tenant_company.manage` permission for accept/reject
- [ ] Read endpoints require `tenant_company.read` permission
- [ ] Authorization middleware already handles `assertBuildingScopedResourceAccess` — frontend does NOT need to re-implement

### 4.4 Error Format
- All API responses use standard format: `{"error": "...", "message": "..."}`
- Frontend should parse `message` field for user-facing error strings
- Specific error keys: `signatureDigest is required`, `rejectReason is required`, `signature verification failed`, `BAST is not in ISSUED status`, `Quality check not complete`, `Building access denied`

### 4.5 Loading States
- Show spinner during challenge fetch
- Show spinner during sign-off submission
- Disable Accept/Reject buttons during in-flight operations
- Show success toast on completion

### 4.6 Accessibility
- Challenge payload JSON should be readable by screen readers (expandable/collapsible format)
- Reject reason text input should have label and error message association
- Toast notifications should be announced by screen readers

### 4.7 Security Review Checklist (Frontend)
- [ ] Challenge nonce is fetched BEFORE any signature operation
- [ ] Signature is obtained from customer's e-signature tool (NOT generated frontend)
- [ ] `rejectReason` is mandatory for REJECT and validated non-empty before submit
- [ ] `idempotencyKey` is included in every sign-off request
- [ ] No arbitrary `signatureDigest` accepted — must come from verified e-signature tool output
- [ ] Challenge nonce expiry is checked (5 minute default)
- [ ] Building guard is enforced by backend — frontend does NOT implement its own building check