# Handyman official inclusive invoice — PART 01C-B

`POST /api/v1/handyman/execution-scopes/:executionScopeId/invoices` requires scoped
`handyman.finance.manage`, `handyman.finance.read`, and
`handyman.customer_tax.read`. Its body contains only `classification` (the
exact reviewed V2 classification/decision pin: `classificationId`, `version`,
`digest`, `decisionId`, `decisionDigest`) and optionally
`documentLanguage` (`id` or `en`). It revalidates the pinned customer offer,
variation consent, signed reductions, individual Finance-approved tax rules,
issuer identity, verified IDR bank and INVOICE settings in one transaction.
Amounts, payment terms and document dates are never supplied by the caller.

The issued invoice has one immutable canonical source, exact per-line inclusive
DPP/PPN and correction references, number, PDF bytes and SHA-256. The original
customer-agreed gross is not increased by PPN. DPP can differ from consideration
before PPN under an approved ratio; it is not added to the gross. Persisting the
source and PDF is atomic and requires durable primary PostgreSQL. The artifact
is not a tax invoice, proof of receipt, paid status, BAST or payment decision.
The invoice includes the original quotation's payment/down-payment terms and
current verified receiving account; it does not invent a due date or payments.

A shared scope claim excludes generic and official Handyman invoices in both
directions, including concurrent writers. Source fences prevent stale snapshots;
new charges and REDUCE bindings cannot be added to an issued invoice, and the
existing variation final-charge gate also recognizes official issuance.
Independent ledger payments, verified allocations, receipts and later separate
ledger corrections remain independent and never rewrite the original invoice.
Pending variations, stale/ambiguous consent, mixed/exclusive bases, unresolved
charges, unsupported methods or unverified masters fail closed. BAST is not
required for legitimate upfront billing. Historical ambiguous offers remain
ineligible; no supplemental-agreement workflow is added.

Finance can download `GET /api/v1/handyman/execution-scopes/:scopeId/invoices/:invoiceId.pdf`.
Care uses `GET /api/v1/handyman/care/requests/:requestId/invoices/:invoiceId/document.pdf`
with its current workspace token and selected `propertyId`, `tenantCompanyId`,
`buildingId`, and (when applicable) `spaceId`. The current Care grant, occupancy,
request, Client, Building, tenant, space, scope and immutable invoice must all
match in the same read. `invoicePayment.officialInvoice` in the Care operational
projection supplies the document identity; it does not derive a paid status.
