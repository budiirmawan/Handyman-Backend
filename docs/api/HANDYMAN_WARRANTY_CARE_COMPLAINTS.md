# Warranty complaints — Customer Care intake

All paths below are under `/api/v1` and require a backend Bearer session. Care
routes require `handyman.care.building` and an active assignment to the **exact**
Building. Client, tenant and unit are derived from the selected Handyman request;
the caller cannot choose a recording or uploading user.

## Issued certificate lookup (read-only)

`GET /handyman/care/buildings/{buildingId}/warranty-certificates` requires at
least one query selector: `tenantCompanyId` and/or `requestId`. If both are
provided they must match. A request is authorized only in the Care user's exact
Client and Building; a tenant-only selection requires an effective active
Building context or an existing request in that exact Building. Historical
requests remain readable after a tenancy ends. The response is `{ items,
nextCursor }`, ordered by issuance time and ID descending; optional `limit`
(1–20, default 20) and `cursor` (the preceding page's `nextCursor`) paginate
within the same selection. Unknown or cross-scope selections return 404, and
missing Care authority is denied.

`GET /handyman/care/buildings/{buildingId}/warranty-certificates/{certificateId}`
requires the same tenant and/or request selector and returns the exact issued
certificate and its covered item snapshots. Both endpoints are private/no-store,
use the existing active Building Care permission and assignment, and verify the
stored official source and PDF integrity. The response includes the real
`certificateId`, `certificateNumber`, issuance `status`, `currentness`
(`CURRENT` or `HISTORICAL`), `warrantyLifecycleStatus`, request/tenant/scope
IDs, the source/PDF hashes and manifest version needed by `submit-claim`.
Detail items contain `itemLineId`, the actual completed item, explicit agreed
`warrantyTerms`, contractual `startsAt` and exclusive `endsAtExclusive`.
`contractualPeriodStatus` (`NOT_STARTED`, `IN_PERIOD`, `ENDED`) is only a
server-time comparison against that item period; it is `null` for historical
scope. `observedAt` identifies the comparison time. Lifecycle status, including
`EXPIRED`, is not the contractual item expiry. These fields are not a claim
eligibility, verification or approval decision.

Only immutable issued certificate items with explicit terms are returned; legacy
or ambiguous terms, non-warranted items, and lifecycle coverage rows do not
create a certificate or inferred coverage. A historical certificate is labelled
and its items are solely the original issued snapshot, not current coverage.
A reported reference remains `PENDING_VERIFICATION` until the existing claim
process proceeds; lookup itself changes no complaint, claim, or lifecycle row.

## Care endpoints

- `POST /handyman/care/buildings/{buildingId}/warranty-complaints` registers a
  report. Required JSON: `requestId`, `channel` (`WHATSAPP`, `PHONE`, `EMAIL`,
  `DIRECT`), `reportedReporterName`, `tenantDescription`, `complaintDate`
  (`YYYY-MM-DD`), and `idempotencyKey` (1–128 characters). Optional:
  `channelReference`, `reportedReporterContact`, `reportedReporterPicId`,
  `occurrenceDate`, `reportedCertificateId`, `reportedItemLineId` (requires a
  certificate), and `internalCareNotes`. The PIC and certificate/item references
  are checked against the request, but are not treated as proof of the reporter's
  identity or of coverage. A channel reference is unique per Client, Building and
  channel. Reusing the same key and facts replays the original complaint;
  different facts or duplicate source references conflict.
- `GET /handyman/care/buildings/{buildingId}/warranty-complaints?requestId=...`
  lists up to 100 most recent scoped reports. The request filter is optional.
- `GET .../warranty-complaints/{complaintId}` returns details, private Care
  notes, evidence metadata, complaint events and assessment history. `GET
  .../{complaintId}/status` returns its current tracking projection.
- `POST .../{complaintId}/evidence` accepts multipart `file` and
  `idempotencyKey`. Supported signatures/MIME types are JPEG, PNG, WebP, PDF,
  MP4 and QuickTime; maximum 50 MB. The server stores and hashes the bytes,
  records the authenticated uploader, and never exposes a storage key.
  `GET .../{complaintId}/evidence/{evidenceId}` is a protected download. New
  evidence may also be added after submission for an assessor's review.
- `POST .../{complaintId}/submit-claim` accepts `certificateId`,
  `certificateSourceSha256`, `certificatePdfSha256`,
  `certificateManifestVersion`, `itemLineId`, `coverageKind` (`LABOR` or
  `PARTS`) and `idempotencyKey`. It verifies the exact request/tenant/unit,
  rechecks the stored complaint bytes and atomically invokes the **existing**
  certificate-bound claim OPEN and SUBMIT commands. The contractual filing
  time is the actual server-side submission time, not `complaintDate`.

A complaint with no linked claim is always `PENDING_VERIFICATION`, even if a
certificate is reported. Subsequent tracking states are `PENDING_ASSESSMENT`,
`NEEDS_EVIDENCE`, `ASSESSED_AWAITING_DECISION`, `APPROVED`, `REJECTED` and
`WITHDRAWN`. The projection includes the real claim status and latest assessment;
intake and submission themselves do not establish warranty entitlement.

## Reporter and assessor

`POST /handyman/warranty-complaints/{complaintId}/reporter-confirmation` with
`{ "iAmReporter": true, "idempotencyKey": "..." }` allows the actual
active, request-tenant PIC to self-confirm using their own authenticated
session. Without this action, the reporter remains `REPORTED_ONLY` even when
Care supplies a name or PIC reference. Self-confirmation is an identity
statement, not commercial consent or a coverage decision; it is not a
prerequisite for filing an honestly labeled report.

An independently authorized `handyman.warranty.assess` user with exact Building
access may use `GET /handyman/service-warranty-claims/{claimId}/complaint` and
`GET .../{claimId}/complaint/evidence/{evidenceId}` to inspect linked report
facts and bytes. Internal Care notes are not exposed. The existing assessment
and approve/reject APIs remain authoritative. The complaint recorder, reported
or self-confirmed reporter, evidence uploaders/importers, and claim opener may
not assess or decide that complaint's claim. `NEEDS_EVIDENCE` can be followed by
another Care upload and a new assessment using its returned
`assessmentEvidenceRecordId`; no field Lead or reporter is impersonated.
