# CR-HM-BE-CARE-NONCATALOG-E2E-01 — PART 02 Production Handoff

Date: 2026-10-30 (Asia/Jakarta)

## Reconciled production baseline

- Verified deployed Backend: `4ff46085baddae487a52e6a7ee01d76ad819bfd9` on `arena/9b080bd1-handyman-backend`.
- `main@11fad55ecae7a153df51cc463290ecc2ad70175c` is an ancestor of that deployed commit.
- The temporary PART 01 direct non-catalog lane was based on the same older main and is superseded by the deployed Unlisted Intake implementation.
- The reconciled source, tests, migration registry, and OpenAPI retain the complete deployed lineage through `0535_handyman_field_evidence_work_session`.

## Migration plan: no new migration

Do **not** deploy `0481_handyman_care_noncatalog_intake`; it was removed during reconciliation and was never part of the verified deployed artifact.

The production-compatible registry keeps:

| Migration | Existing authority |
|---|---|
| `0481_handyman_commercial_consent_bridge` | Deployed commercial consent bridge; the legitimate owner of number 0481 |
| `0483_handyman_care_initial_scheduling_preference` | Initial Care scheduling preference for catalog requests |
| `0485_handyman_internal_notes` | Append-only INTERNAL_ONLY notes |
| `0486_handyman_unlisted_service_intake_cases` | Unlisted intake, exact scope, idempotency, complaint, and preferred window |
| `0487_handyman_unlisted_intake_operations_triage` | Operations triage decisions and state |
| `0488_handyman_unlisted_intake_formal_request_conversion` | One governed manual-origin Service Request with no fabricated catalog ID |

There is no `0536` or other new schema change in PART 02. The final migration registry is identical to the verified deployed artifact: 533 unique registered IDs, latest `0535`. This avoids adding a lower-numbered pending ID ahead of an already-advanced ledger and avoids weakening the deployed conditional catalog constraints.

The runner requires the applied ledger and artifact registry to match exactly and rejects unknown applied IDs. The supplied production summary (`52 applied`, latest `0535`) was not expanded through a production connection in this PART. An authorized deployment operator must retain the normal migration-status/readiness preflight; no production migration is requested or authorized by this handoff.

## Authoritative Frontend flow

All paths below are under `/api/v1`. Schemas and operation details are in `docs/api/openapi.yaml`.

### 1. Create the Unlisted Intake Case

```http
POST /handyman/care/buildings/{buildingId}/unlisted-intake-cases
Authorization: Bearer <Customer Care session>
Idempotency-Key: <unique key>
Content-Type: application/json
```

Representative body:

```json
{
  "tenantCompanyId": "11111111-1111-4111-8111-111111111111",
  "tenantPicId": "22222222-2222-4222-8222-222222222222",
  "spaceId": "33333333-3333-4333-8333-333333333333",
  "requestedServiceName": "Antique cabinet hinge repair",
  "description": "The hinge is broken and the required replacement part is not catalogued.",
  "preferredWindowStart": "2026-11-03T02:00:00.000Z",
  "preferredWindowEnd": "2026-11-03T05:00:00.000Z",
  "internalNote": "Do not promise a visit time before Operations reviews the request."
}
```

- `requestedServiceName` is required, trimmed to 1–250 characters.
- `description` is the customer complaint and is required, trimmed to 1–2000 characters.
- Do not send a non-null `serviceCatalogId` or `serviceVariantId`.
- `tenantPicId`, `spaceId`, preferred window, and `internalNote` are optional. Existing approval/cost-party fields remain supported.
- Preferred start/end must be supplied together with start before end. The timezone is server-derived; this is a preference, not an appointment.
- A new case returns **201** with `status=PENDING_TRIAGE`; an identical replay returns **200** with `replayed=true`.
- Treat the returned `data.id` as `intakeCaseId`. It is not yet a formal Service Request or Work Order.

Authoritative readback:

```http
GET /handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}
GET /handyman/care/buildings/{buildingId}/unlisted-intake-cases
```

The detail contains the complaint, preferred window, triage projection/history, converted request binding when present, and authorized chronological INTERNAL notes.

### 2. INTERNAL Care Notes

Use the existing separate note authority, either inline during case creation or after creation:

```http
POST /handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}/internal-notes
GET  /handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}/internal-notes
```

Notes are `INTERNAL_ONLY`, append-only, idempotent, and separate from the customer complaint. Never expose them in Tenant UI, customer communications, quotations, BAST, invoices, payments, or notifications. If inline note creation fails after the case commits, retry only the note against the returned `intakeCaseId`; do not recreate the case.

### 3. Operations queue and triage

```http
GET  /handyman/operations/unlisted-intake-cases
GET  /handyman/unlisted-intake-cases/{intakeCaseId}
POST /handyman/operations/unlisted-intake-cases/{intakeCaseId}/triage-decisions
GET  /handyman/operations/unlisted-intake-cases/{intakeCaseId}/triage-decisions
```

Only authorized Operations may triage. The governed decisions are:

- `MATCH_EXISTING_CATALOG_SERVICE`
- `CREATE_CLIENT_CUSTOM_SERVICE`
- `ONE_TIME_MANUAL_QUOTATION_REQUIRED`
- `REQUEST_MORE_INFORMATION_OR_INSPECTION`
- `REJECT_UNSUPPORTED`

Use `REQUEST_MORE_INFORMATION_OR_INSPECTION` when technical clarification or inspection is required. Triage does not fabricate a catalog row, quotation, customer approval, price, dispatch, or Work Order. Existing inspection and Operations-only quotation gates remain downstream authority.

### 4. Formal Service Request conversion

Only the eligible manual-quotation triage branch can be converted by Operations:

```http
POST /handyman/operations/unlisted-intake-cases/{intakeCaseId}/service-request
Idempotency-Key: <unique conversion key>
```

The response links the same case to one formal request with `intakeSource=UNLISTED_TRIAGE`, `serviceCatalogId=null`, and `serviceVariantId=null`. Scope, parties, complaint, and provenance come from the verified case—not from caller overrides. Conversion does not itself approve a quotation, confirm an appointment, or create a Work Order.

## PART 01 contract withdrawn by reconciliation

The following temporary PART 01 behaviors must not be implemented against this production lineage:

- Do not call `POST /handyman/care/buildings/{buildingId}/requests` without a catalog ID. That endpoint remains the existing **Katalog** create contract.
- Do not send `internalNote` to the Katalog create endpoint.
- Do not expect PART 01's `data.internalNote`, `data.preferredWindow`, or Operations-queue `intakeType` additions. Use the Unlisted Intake detail and Operations Unlisted Intake queue instead.
- Do not triage an unlisted case through `/handyman/requests/{requestId}/triage`; use its Operations `triage-decisions` contract before any formal conversion.
- Do not invent a dummy catalog entry or a second local migration/note table.

Existing Katalog creation, scheduling readiness, evidence, inspection, quotation, approval, payment, and downstream lifecycle contracts remain on their deployed paths.
