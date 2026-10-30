# Scope variation offers

Operations' existing `revised-quotation` transition atomically issues a numbered
`VARIATION_ORDER` PDF. Its `REVISED_QUOTATION` event includes `offerDocument`
(`id`, `version`, `number`, `pdfSha256`, `sourceSha256`). `ISSUED` means **offer
only**: it is not Tenant PIC consent or permission to execute work.

- Local Operations or Building Care: `GET /api/v1/handyman/execution-scopes/:scopeId/variations/:variationId/offer.pdf`
- Customer Care workspace: `GET /api/v1/handyman/care/requests/:requestId/variations/:variationId/offer.pdf`, with the existing `propertyId`, `tenantCompanyId`, `buildingId`, and (where applicable) `spaceId` selection.

Both routes return the immutable bytes, `X-Content-SHA256`,
`X-Variation-Offer-Id`, and `X-Variation-Offer-Version`. The Care request
projection lists issued offers and their download paths. Care may manually
deliver the document; downloading it does not record delivery or approval.

The Tenant PIC's existing `tenant-decision` request must include
`revisedQuotationVersionId`, `expectedVersion`, `offerDocumentId`,
`offerDocumentVersion`, and `offerPdfSha256`, along with the existing
decision/evidence and applicable ADD line/Work Order fields. The offer ID,
version, and checksum must match the bytes actually reviewed. Changes require a
new variation and issued quotation, then a fresh decision; existing approved
scope and execution gates are unchanged.

The offer pins the original approved and revised official quotation documents,
their lines and commercial terms, the applicable issuer/settings/bank snapshots,
and the variation details. The revised quotation must remain a current unapproved
ISSUED offer when consent is recorded. Historical quotation versions or pending
variations without an original official document are not backfilled; issue a new
governed variation against available official sources. Existing historical
approvals and documents are retained.
