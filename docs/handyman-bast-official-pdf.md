# Official Handyman BAST PDF

New BAST ISSUE requires one active BAST document-settings language and an active issuer profile, the current guarded QC PASS, and the exact Supervisor-verified completion manifest. The ISSUE event, numbered PDF, canonical snapshot, SHA-256 digests and PDF bytes commit together in durable primary PostgreSQL. Missing, altered or oversized evidence aborts issuance; the PDF contains the verified execution and QC files as attachments (28 MiB combined evidence, 32 MiB final PDF maximum). Quantities are printed as exact decimal text. Historic BASTs are not backfilled.

* Local Building Care: `GET /api/v1/handyman/basts/:bastId/document.pdf`.
* Care workspace: `GET /api/v1/handyman/care/requests/:requestId/basts/:bastId/document.pdf?propertyId=...&tenantCompanyId=...&buildingId=...&spaceId=...` (`spaceId` is omitted for a building-only request). The current workspace property grant and exact represented occupancy are required.

Both endpoints return the original bytes with `X-Content-SHA256`, `X-Document-Source-SHA256`, `X-BAST-Document-Id` and `X-BAST-Document-Number`. Download is for manual delivery and does not assert delivery or tenant acceptance. The immutable PDF describes the ISSUED state at issue time; a later ACCEPTED/REJECTED/VOID status is independent and never rewrites the PDF or fabricates a signature.
