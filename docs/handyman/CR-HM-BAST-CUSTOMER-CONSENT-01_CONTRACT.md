# PART 04 — Personal customer BAST consent contract

> **Commercial bridge PART01 addendum (2026-10-25):** this document freezes the optional direct-PIC V1 channel, not a universal login requirement. A distinct, default-BLOCKED verified Care-recording receipt now composes the same BAST transaction and shared downstream qualifier. V1 bytes/meaning and all QC/identity/audit protections remain unchanged; no legacy receipt is upgraded. See [bridge contract](CR-HM-COMMERCIAL-DECISION-BRIDGE-01_PART-01.md).

**CR-HM-BE-IAM-E2E-AUDIT-01 · 2026-10-25 · Backend contract, not production certification.**

This is the explicitly approved **authenticated electronic consent** contract. It is **not a certified digital signature**, external signature verification, biometric identity verification, or an independently verified delegation facility. A SHA-256 value, uploaded image, role, Building assignment, email, phone, reporter or staff attestation is never customer authority.

## 1. Existing routes and authority

All paths below are relative to `/api/v1`. No endpoint, request property, response property, table or migration was added. OpenAPI now also documents the already-returned `artifactRef`, `approvedSignOff` and `signOffComplete` read fields; these are not new response data.

| Existing operation | Required authority / unchanged lifecycle |
| --- | --- |
| `GET /handyman/execution-scopes/{executionScopeId}/bast`, `GET /handyman/bast/{bastId}` | Existing local session, `tenant_company.read`, exact Client/Building; support staff may read, not consent |
| `POST /handyman/bast/{bastId}/accept` | Personal authenticated current exact-request PIC, live `tenant_company.manage`, exact Building, active account/PIC/Company and current exact-space occupancy; issued manifest and current genuine bound Supervisor QC PASS |
| `POST /handyman/bast/{bastId}/reject` | Same personal customer authority and issued manifest; rejection does not require a new/current PASS |
| `POST /handyman/bast/{bastId}/sign-off` | **Alias for the same customer ACCEPT/REJECT**, never provider signing |
| Provider `/handyman/field/execution-scopes/{executionScopeId}/bast/prepare`, `/handyman/field/bast/{bastId}/{issue,void}` | Existing dedicated `handyman.bast.manage`, exact Building and CURRENT Crew Lead; never customer acceptance |
| `/handyman/service-warranty-reworks/{reworkId}/authorize` | Same personal request-PIC authority; existing free-rework machine/events remain |
| `/handyman/chargeable-additional-works/{workId}/{accept,reject}` | Same personal request-PIC authority; existing decision/payment-trigger transaction remains |

Operations, Care, Manager, Owner (`PLATFORM_ADMIN`), an ordinary administrator, or the Crew Lead cannot consent merely through grants or scope membership. There is no delegate registry: no delegated/customer-surrogate fallback. Backend derives actor from the authenticated session and lineage from the stored target, never from body identity claims. PART 03 PIC administration remains unchanged; it cannot rewrite an old decision actor.

## 2. Canonical digest V1

Protocol: **`HM-BAST-CUSTOMER-CONSENT-SHA256-V1`**.

Backend reconstructs this manifest from authoritative locked BAST/scope records, its immutable ISSUE event, QC binding and optional finalized evidence. It is a reference manifest of stored immutable domain facts, **not** a hash/certification of rendered PDF bytes; no persisted signed-PDF service is invented. ACCEPT must supply the matching digest. REJECT may omit/empty its digest; Backend calculates and stores it. Any nonempty REJECT digest must also match. Input hex case is normalized to lowercase; arbitrary or merely well-formed hex is insufficient.

Hash **UTF-8 bytes of JavaScript `JSON.stringify` of the following ordered array** (no whitespace, no object-key sorting, no prefix such as `sha256:`):

```text
[
  protocol,
  bast.id,
  scope.id,
  scope.approvedQuotationVersionId,
  scope.clientId,
  scope.handymanRequestId,
  scope.tenantCompanyId,
  scope.tenantPicId,
  scope.buildingId,
  issuedArtifact.ref,
  issuedArtifact.version,
  issueEvent.id,
  bast.issuedAt_as_ISO_UTC_milliseconds,
  bast.qcRunId,
  authenticatedUser.id,
  "ACCEPT" or "REJECT",
  normalizedRejectReason_or_null,
  evidenceTuple_or_null
]
```

* UUIDs use Backend-returned lowercase UUID strings. Dates use `YYYY-MM-DDTHH:mm:ss.sssZ`.
* `issuedArtifact.ref` means the existing customer read's `acceptance.artifactRef`; the version is frozen at 2 by this protocol and the existing Backend artifact mapper. The **issued** artifact is `BAST/{id}/v2`, version **2**. Do not hash the terminal ACCEPTED/REJECTED artifact `v3`, or a different BAST after VOID/replacement.
* ACCEPT reason is `null`. REJECT reason is trimmed; absent/blank becomes `null`; maximum 2,000 characters. Use literal JSON `null`, not `"null"`, undefined or an omitted array entry.
* Output is 64 hexadecimal SHA-256 characters. Non-ASCII text is UTF-8, without Unicode normalization; do not change the JSON escaping/spacing. Other languages must match `JSON.stringify` (e.g. Python compact separators and `ensure_ascii=False`).
* The idempotency key is not a manifest field; preserve it separately for retry. The server decision timestamp is not a client claim; immutable DB event/sign-off timestamps bind the receipt to the status change.

Optional attachment tuple:

```text
[
  evidenceRecord.id,
  earliest_FINALIZE_event.id,
  [
    [file.id, file.mediaKind, file.contentType, file.byteSize_as_number, file.sha256Digest],
    ...files_sorted_by_lowercase_UUID_ascending_ASCII
  ]
]
```

The record must belong to the same Client/execution scope, be finalized and have files. Backend reads the actual managed bytes and verifies size and SHA-256, not just declared metadata. The immutable file-set snapshot is stored with the consent. The attachment is optional and **is not identity/signature verification**. The QC gate independently verifies genuine current Supervisor PASS/checklist/work-session/defect/QC-byte prerequisites through the existing engine.

Reference codec and manifest type: `src/modules/handyman-bast/handyman-bast-customer-consent.ts`. Independent ordered-array, changed-field, file-order, HTTP and stored-byte tests: `tests/handyman-bast-customer-authority-part04.test.ts`.

### Obtain inputs, do not invent them

Use the existing BAST reads while it is ISSUED (including `issuedAt`, `qcRunId`, ISSUE event ID and Backend artifact), and the existing public execution-scope snapshot/`GET /handyman/quotation-versions/{quotationVersionId}/execution-scope` for immutable root IDs and approved quotation version. Optional evidence detail is `GET /handyman/evidence-records/{evidenceRecordId}` (the existing customer-care read), exposing finalized events and file digests without storage keys. Get the User ID from the authenticated personal session, not a customer selector.

The scope must be the one referenced by that BAST. A client starting from a deep link must load the existing request/quotation/Work Order context; it cannot invent missing IDs or substitute a support user's session. If these reads, the personal account or a trustworthy issued manifest are unavailable, **disable submission/fail closed**. There is no new manifest/signature endpoint and no Care fallback.

### Existing request shapes

```json
{
  "idempotencyKey": "stable-client-intent-key",
  "signatureDigest": "<computed canonical 64-hex SHA-256>",
  "evidenceRecordId": null
}
```

For `/sign-off`, additionally send `"decision": "ACCEPT"` or `"REJECT"`. For `/reject` or a REJECT alias, use `rejectReason` (not `reason`) and optionally omit `signatureDigest`. Do not send actor/signer/customer/Client/Company/PIC/Building/scope/version/delegate/metadata fields. Unknown BAST decision fields are rejected, not adopted. Omit `rejectReason` from `/accept` (it is not part of that request schema); for an ACCEPT alias, omit it or send `null`, never a nonblank rejection reason. Preserve the original issued manifest/digest and key across retries; do not recompute against the response's terminal artifact.

## 3. Provenance, concurrency and replay

* Existing immutable BAST event stores authenticated actor, DB transaction time, decision and private `metadata.customerConsent = { method: "AUTHENTICATED_REQUEST_PIC", manifest, sha256Digest }`. Existing immutable sign-off stores the matching event/digest/evidence/reason. No browser actor/time/status is written.
* Scope → BAST locking is shared by provider ISSUE/VOID and customer decisions, matching PREPARE/QC/final-close scope serialization. Current PIC/account SHARE locks from PART 03 survive until commit; governed relink must wait or the old customer fails the rechecked authority read.
* Head, event and sign-off insertions are one transaction. Any denial/persistence failure leaves BAST and downstream Work Order, QC, invoice, payment, ledger, warranty and close facts unchanged.
* Same current authorized **original actor**, action, normalized payload and key replay the original receipt with `replayed: true`. Changed actor/digest/evidence/reason, a conflicting decision or a new key on a terminal document is not a new acceptance.
* A later legitimate PIC relink does not erase the old actor's valid historical consent. The old User loses current authority; the replacement cannot adopt/replay the old receipt as theirs (409). Replay is not a fresh QC/attachment-availability attestation.

## 4. Existing read flags and downstream prerequisites

Use Backend `customerAccepted`, `warrantyStartEligible`, `approvedSignOff` and `signOffComplete`, **not raw status/nonempty digest alone**. These existing runtime fields now require a coherent immutable personal-consent receipt. Status remains the existing DRAFT/ISSUED/ACCEPTED/REJECTED/VOID ladder; no second state machine was added.

Legacy staff/digest-only ACCEPTED rows retain their status, actor, timestamps and history. They are **not** backfilled or retrospectively certified: qualified flags are false and warranty start, variation final-charge eligibility and the Manager close BAST gate fail closed. Existing warranties/financial/closed-history facts are not deleted or unwound. Terminal legacy cases require separately approved prospective reconciliation; no repair endpoint or production backfill is part of PART 04.

Valid consent satisfies **only the BAST prerequisite**. It does not pay/finalize an invoice, verify a bank receipt, close a Work Order, start warranty automatically or transfer tenant funds. Finance/Manager's other existing QC/work/material/variation/payment/ledger/invoice/exception guards remain mandatory. Tenant pays Handyman directly; Handyman's BM cooperation fee remains separate.

## 5. Failures and rollout boundary

| Failure | Existing envelope/code |
| --- | --- |
| No local authenticated personal session | Authentication 401 |
| Not current exact-request PIC / inactive account, PIC, Company or effective occupancy | `403 HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN` (authentication may reject an inactive session earlier) |
| Missing route/live capability or exact Building | Existing `403 PERMISSION_DENIED` / `BUILDING_ACCESS_DENIED` |
| Missing ACCEPT digest | `400 HANDYMAN_BAST_SIGNATURE_REQUIRED` |
| Mismatched canonical digest, unavailable issued manifest, invalid/unfinalized/foreign/missing/tampered attachment | `400 HANDYMAN_BAST_VALIDATION` |
| Forged/unknown body fields | `400 VALIDATION_ERROR` |
| Unissued/void/terminal/conflicting/rebound replay | `409 HANDYMAN_BAST_ILLEGAL_TRANSITION` |
| ACCEPT's current QC guard fails | `409 HANDYMAN_BAST_QC_NOT_READY` |
| Persistence failure | Existing 500; entire consent transaction rolls back |

No production deployment, account enrollment, live customer/signature verification, certified-signature provider, legacy reconciliation or Frontend implementation was performed. Clients using opaque legacy digests must update before rollout. See [PART 04 audit](../audits/CR-HM-BE-IAM-E2E-AUDIT-01-PART-04.md); production remains NO-GO for the broader audit gates.
