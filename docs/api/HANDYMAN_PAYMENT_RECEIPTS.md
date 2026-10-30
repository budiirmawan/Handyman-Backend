# Payment Receipt numbering and Care discovery

## Configuration and explicit activation

Numbering is **not enabled by migration or by settings alone**. A manager with
`handyman.commercial.manage` and access to the issuing provider Client first
configures `PAYMENT_RECEIPT` using the existing settings API:

`PUT /api/v1/handyman/clients/{clientId}/document-settings/PAYMENT_RECEIPT/{id|en}`

The normal settings body and optimistic `expectedVersion` apply; `documentPrefix`
must be `HM-PR`. The Client is the existing issuer-profile legal-entity scope.
The settings' `ACTIVE` status means the configuration is current, not approved.
No customer, Care actor or Finance issue request can approve it implicitly.

The authorized manager must then explicitly approve that exact settings ID and
version using the same Client-scope and commercial-permission controls:

`POST /api/v1/handyman/clients/{clientId}/document-settings/PAYMENT_RECEIPT/{id|en}/numbering/activate`

```json
{
  "settingsId": "<active settings UUID>",
  "settingsVersion": 1,
  "policyCode": "HM_PR_ISSUER_YEAR_V1",
  "approve": true
}
```

This records the actual authenticated manager, session and approval time. The
fixed policy is `HM-PR-{YYYY}-{SEQ:06}`, with a separate counter for each issuer
Client and calendar year; the year changes at midnight on January 1 in
`Asia/Jakarta`. The selected language identifies the explicitly approved settings
version; the counter is shared across languages. Only one policy approval is
active per Client. Repeating the same activation returns its existing decision;
replacing the approved settings version makes it unusable for new issuance until
another explicit approval. The response includes the policy format, scope,
timezone, approver and settings pin.

The existing manual Finance ISSUE requires an active approval for new receipts.
It allocates the number transactionally with the immutable PDF and source
snapshot. A missing/stale approval, exhausted six-digit sequence, duplicate
number or unresolved concurrent conflict fails closed. Replaying an existing
receipt does not allocate another number and does not require a current policy.
Identical formatted numbers may exist for different issuer Clients, never twice
within one issuer. This does not verify or allocate payments, issue a receipt
automatically, or assert invoice settlement.

## Care workspace discovery

`GET /api/v1/handyman/care/requests/{requestId}` includes a read-only
`paymentReceipts` array, in issued-time/ID order. Use the existing workspace
Bearer session and the existing `propertyId`, `buildingId`, `tenantCompanyId`
and optional `spaceId` selection. Authorization and receipt discovery share
one statement snapshot. An empty array means **no discoverable issued Payment
Receipts**, not that the request or invoice is unpaid.

Each item contains `receiptId`, `documentNumber`, `status: "ISSUED"`,
`paymentId`, `requestId`, `executionScopeId`, `transactionId`, decimal-string
`amount`, `currency`, `obligationStage`, `issuedAt`, `sourceAsOf`, source/PDF
SHA-256 values and the existing scoped `downloadPath` (pass the same selection
when downloading). For a newly numbered receipt `documentNumber` is the exact
number in its stored snapshot and PDF. Historical receipts without an assigned
number retain `documentNumber: null`; their bytes, hashes and snapshots are not
backfilled or changed. The immutable receipt UUID remains the document ID.

Only a real immutable receipt of an independently confirmed or reconciled
payment is listed. Pending claims, uploaded proofs and verified payments that
have not been issued a receipt are not documents and never appear. Allocation
facts in a receipt remain its as-of snapshot; subsequent allocations or
corrections do not rewrite the document or imply full payment.

`invoiceAtIssuance` is the exact invoice reference printed in the receipt,
including its status at that time and kind (`OFFICIAL_HANDYMAN` or
`TENANT_INVOICE`), or `null` if none existed. `linkedOfficialInvoice` is a
separate current, explicit payment-to-official-invoice link, if present. A DP or
termin receipt issued before an invoice remains discoverable through its
verified payment/request lineage; a later link does not change its PDF or
retroactively put an invoice reference into it. Use the request/payment PDF
path for such documents, not the invoice-specific PDF path.

Conflicting Client, Building, tenant, request, scope, payment, verification,
allocation, numbering or invoice lineage, multiple receipts for one payment,
or duplicate numbers for one issuer fail closed with
`409 HANDYMAN_TENANT_RECEIPT_INTEGRITY_ERROR`. A request may have many different
issued receipts. Unauthorized contexts retain the existing 404 and invalid Care
sessions are rejected. The download still performs independent authorization
and byte-integrity verification.
