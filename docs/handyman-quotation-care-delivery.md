# Manual quotation delivery by Care

Care can read and append delivery events for one official quotation version:

- Local Building Care: `/api/v1/handyman/care/buildings/:buildingId/requests/:requestId/quotations/:quotationId/versions/:versionId/delivery-events`
- Care workspace: `/api/v1/handyman/care/requests/:requestId/quotations/:quotationId/versions/:versionId/delivery-events`

Both paths support `GET` (ordered history) and `POST`, with the existing respective Care credentials and scope checks. Responses are `private, no-store`. The server derives the Client, tenant, Building and actual recorder; caller-supplied actor fields are rejected. Each event pins the quotation, exact version, immutable document and PDF SHA-256. Existing Care PDF downloads automatically append `DOWNLOADED`; this means the server prepared a successful PDF response, not that the tenant received it. Operations-only downloads do not create a Care event. Historical versions without an official document cannot be recorded.

To record a manual send, POST:

```json
{"type":"SENT","pdfSha256":"<X-Content-SHA256 from the official PDF>","channel":"WHATSAPP","recipientName":"Tenant PIC","recipientContact":"+628123456789","recipientPicId":"<optional tenant PIC UUID>","evidenceId":"<optional request-owned evidence UUID>","occurredAt":"2026-10-27T08:00:00.000Z","idempotencyKey":"<unique Care-actor key>"}
```

`channel` is `WHATSAPP`, `EMAIL`, or `DIRECT`; contact is required for the first two and optional for `DIRECT`. Recipient name/contact are Care-reported, not identity verification; any selected PIC must be active and belong to the request's tenant. `occurredAt` is optional, Care-reported UTC time, distinct from the server's `recordedAt`; it cannot be in the future or before issuance. Only the currently valid `ISSUED` version may be newly sent. The checksum must match the official document, and an optional evidence reference must be an active, non-purged, request-owned managed file with intact SHA-256 bytes. The API does not send messages.

To confirm delivery, a **different** authorized Care actor in the **same identity realm** as the sender must independently review provider receipt or tenant acknowledgement evidence and POST:

```json
{"type":"DELIVERED","pdfSha256":"<same official PDF SHA-256>","sentEventId":"<SENT event UUID>","evidenceId":"<request-owned proof UUID>","evidenceKind":"PROVIDER_RECEIPT","reviewed":true,"idempotencyKey":"<reviewer's unique key>"}
```

`evidenceKind` is `PROVIDER_RECEIPT` or `TENANT_ACKNOWLEDGEMENT`. Before asserting `reviewed: true`, the reviewer must inspect the proof and confirm it establishes delivery of the exact document to the recorded recipient via the recorded channel. The server validates ownership, available bytes and checksum, and pins the proof hash, but **cannot authenticate or interpret the proof's content**. `DELIVERED` is therefore an independent human evidence-review record, not a cryptographically verified provider callback. A different local user cannot verify a workspace actor (or vice versa), because those identities have no reliable cross-realm person binding. Optional `occurredAt` may record the reviewer-reported delivery time. Missing proof, self-review, foreign evidence, or mismatched SENT/document is rejected. A later purge under existing evidence-retention rules may make the historical proof unavailable; the recorded hash remains.

All events are append-only. Replaying the same actor/idempotency key and identical payload returns the original fact; a changed payload conflicts. Neither `DOWNLOADED`, `SENT` nor `DELIVERED` is customer approval: existing separately verified Tenant PIC APPROVE/REJECT and commercial-consent rules are unchanged.
