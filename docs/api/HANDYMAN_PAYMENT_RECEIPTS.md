# Care workspace Payment Receipt discovery

`GET /api/v1/handyman/care/requests/{requestId}` now includes a read-only
`paymentReceipts` array, in issued-time/ID order. Use the existing workspace
Bearer session and the existing `propertyId`, `buildingId`, `tenantCompanyId`
and optional `spaceId` selection. Authorization and receipt discovery share
one statement snapshot. An empty array means **no discoverable issued Payment
Receipts**, not that the request or invoice is unpaid.

Each item contains `receiptId`, `status: "ISSUED"`, `paymentId`, `requestId`,
`executionScopeId`, `transactionId`, decimal-string `amount`, `currency`,
`obligationStage`, `issuedAt`, `sourceAsOf`, source/PDF SHA-256 values and the
existing scoped `downloadPath` (pass the same selection when downloading).
Only a real immutable receipt of an independently confirmed or reconciled
payment is listed. Pending claims, uploaded proofs and verified payments that
have not been issued a receipt are not documents and never appear. Allocation
facts in a receipt remain its as-of snapshot; subsequent allocations or
corrections do not rewrite the document or imply full payment.

The current official Payment Receipt engine identifies its PDF by its issued
UUID; it has **no separate numbered document field**. `documentNumber` is
therefore `null`, not a fabricated number or a relabelled UUID. The immutable
receipt ID remains the authoritative document identifier.

`invoiceAtIssuance` is the exact invoice reference printed in the receipt,
including its status at that time and kind (`OFFICIAL_HANDYMAN` or
`TENANT_INVOICE`), or `null` if none existed. `linkedOfficialInvoice` is a
separate current, explicit payment-to-official-invoice link, if present. A DP or
termin receipt issued before an invoice remains discoverable through its
verified payment/request lineage; a later link does not change its PDF or
retroactively put an invoice reference into it. Use the request/payment PDF
path for such documents, not the invoice-specific PDF path.

Conflicting Client, Building, tenant, request, scope, payment, verification,
allocation or invoice lineage, or multiple receipts for the same payment, fails
closed with `409 HANDYMAN_TENANT_RECEIPT_INTEGRITY_ERROR`. A request may have
many different issued receipts. Unauthorized contexts retain the existing 404
and invalid Care sessions are rejected. The download still performs the
existing independent authorization and byte-integrity verification.
