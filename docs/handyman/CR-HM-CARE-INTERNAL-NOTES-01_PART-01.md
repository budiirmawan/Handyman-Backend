# CR-HM-CARE-INTERNAL-NOTES-01 — PART 01: Backend Internal Notes

- **Date:** 2026-10-26 (Asia/Jakarta)
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch:** `arena/9fdd2eb4-handyman-backend`
- **Care Baseline Commit:** `ebd6cf585097b8de16c99092ed624000a229b833`
- **Migration Identifier:** `0485_handyman_internal_notes`

---

## 1. Objective and Scope

Implements a dedicated, append-only **Internal Notes** capability shared by Customer Care and authorized Handyman Operations within their authoritative Client and Building scope.

Internal notes are strictly separated from:
- customer complaint / service item descriptions (`handyman_service_requests.description`, `handyman_service_request_items.item_description`);
- technical attributes, quantities, UOMs, and variants (`handyman_service_request_items`);
- access conditions (`handyman_service_request_items.access_condition`);
- quotation lines and pricing notes (`handyman_quotation_lines`, `handyman_quotation_versions`);
- neutral customer communications (`handyman_care_communications`).

---

## 2. Data Model (`0485_handyman_internal_notes`)

Table: `handyman_internal_notes`

| Column | Type | Constraints / Purpose |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | Unique internal note identifier |
| `client_id` | `UUID NOT NULL REFERENCES clients(id)` | Server-derived Client scope matching parent record |
| `tenant_company_id` | `UUID NOT NULL REFERENCES tenant_companies(id)` | Server-derived Tenant Company scope matching parent record |
| `building_id` | `UUID NOT NULL REFERENCES buildings(id)` | Server-derived Building scope matching parent record |
| `space_id` | `UUID NULL REFERENCES spaces(id)` | Server-derived Unit/Space scope matching parent record |
| `subject_type` | `TEXT NOT NULL DEFAULT 'SERVICE_REQUEST'` | `CHECK (subject_type IN ('SERVICE_REQUEST', 'UNLISTED_SERVICE_INTAKE_CASE'))` |
| `handyman_request_id` | `UUID NULL REFERENCES handyman_service_requests(id)` | Originating catalog service request (`NOT NULL` when `subject_type = 'SERVICE_REQUEST'`); composite FK `(handyman_request_id, client_id, building_id)` |
| `unlisted_intake_case_id` | `UUID NULL` | Extensible reference for future `UNLISTED_SERVICE` intake cases (`NOT NULL` when `subject_type = 'UNLISTED_SERVICE_INTAKE_CASE'`) |
| `visibility_classification` | `TEXT NOT NULL DEFAULT 'INTERNAL_ONLY'` | `CHECK (visibility_classification = 'INTERNAL_ONLY')` |
| `author_role` | `TEXT NOT NULL` | `CHECK (author_role IN ('CUSTOMER_CARE', 'OPERATIONS'))` |
| `created_by_user_id` | `UUID NULL REFERENCES users(id)` | Authenticated Backend session actor (`num_nonnulls(created_by_user_id, created_by_care_actor_id) = 1`) |
| `created_by_care_actor_id` | `UUID NULL REFERENCES handyman_handoff_care_actors(id)` | Attested BM Care Workspace actor (`author_role = 'CUSTOMER_CARE'`) |
| `content` | `TEXT NOT NULL` | Multiline operational text, trimmed length `1..4000`, no NUL characters |
| `idempotency_key` | `TEXT NOT NULL` | Trimmed length `1..200`; unique per `(created_by_user_id, idempotency_key)` and `(created_by_care_actor_id, idempotency_key)` |
| `payload_hash` | `TEXT NOT NULL` | Canonical SHA-256 hex digest of subject + scope + normalized content |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Server-recorded creation timestamp |

### Database Triggers
1. **`trg_handyman_internal_notes_guard_insert` (`BEFORE INSERT`)**:
   - Enforces `visibility_classification = 'INTERNAL_ONLY'`.
   - Verifies that `client_id`, `tenant_company_id`, `building_id`, and `space_id` match the authoritative `handyman_service_requests` record when `subject_type = 'SERVICE_REQUEST'`.
   - Rejects any `created_by_user_id` linked to `tenant_pics` (`23514`), preventing customer-facing accounts from authoring internal notes even at the SQL layer.
2. **`trg_handyman_internal_notes_immutable` (`BEFORE UPDATE OR DELETE`)**:
   - Rejects any `UPDATE` or `DELETE` on `handyman_internal_notes` (`23514`), guaranteeing append-only history and immutable audit provenance.

---

## 3. Backend API Endpoints

All endpoints are mounted under `/api/v1` and set `Cache-Control: no-store`.

| Method | Path | Primary Consumer | Auth & Scope Gate |
|---|---|---|---|
| `POST` | `/handyman/care/buildings/{buildingId}/requests/{requestId}/internal-notes` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `GET` | `/handyman/care/buildings/{buildingId}/requests/{requestId}/internal-notes` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `POST` | `/handyman/care/requests/{requestId}/internal-notes` | Care Workspace / Care Session | `Bearer hcw_...` workspace token (with property grant + occupancy scope) OR Care session (`handyman.care.building` + exact Building) |
| `GET` | `/handyman/care/requests/{requestId}/internal-notes` | Care Workspace / Care Session | `Bearer hcw_...` workspace token OR Care session (`handyman.care.building` + exact Building) |
| `POST` | `/handyman/requests/{handymanRequestId}/internal-notes` | Customer Care & Handyman Operations | Care (`handyman.care.building` or `hcw_...`) or Operations (`service_request.manage` / `work_order.manage` / internal `tenant_company.manage`) + exact `(clientId, buildingId)` scope (BE-02G); non-PIC |
| `GET` | `/handyman/requests/{handymanRequestId}/internal-notes` | Customer Care & Handyman Operations | Care (`handyman.care.building` or `hcw_...`) or Operations (`service_request.read` / `work_order.read` / non-PIC `tenant_company.read`) + exact `(clientId, buildingId)` scope (BE-02G); non-PIC |

### Request Payload (`POST`)

```json
{
  "content": "Multiline operational note for technicians.\nAccess key held at Tower A engineering desk.",
  "idempotencyKey": "care-note-req-01-a"
}
```
- `content` (required, string, 1–4000 chars after normalizing `\r\n` to `\n` and trimming outer whitespace; internal newlines are preserved). `note` is accepted as an optional alias when `content` is omitted.
- `idempotencyKey` (required in body or `Idempotency-Key` header, 1–200 chars).
- Any caller-supplied identity or scope override (`createdByUserId`, `careActorId`, `clientId`, `buildingId`, `tenantCompanyId`, `visibilityClassification`, etc.) is rejected with `400 VALIDATION_ERROR`.

### Response DTO (`POST` 201 / 200 and `GET` 200 items)

```json
{
  "id": "uuid",
  "clientId": "uuid",
  "tenantCompanyId": "uuid",
  "buildingId": "uuid",
  "spaceId": "uuid-or-null",
  "subjectType": "SERVICE_REQUEST",
  "handymanRequestId": "uuid",
  "unlistedIntakeCaseId": null,
  "visibilityClassification": "INTERNAL_ONLY",
  "authorRole": "CUSTOMER_CARE",
  "createdByUserId": "uuid-or-null",
  "createdByCareActorId": "uuid-or-null",
  "authorDisplayName": "Building Care",
  "author": {
    "actorType": "USER",
    "role": "CUSTOMER_CARE",
    "userId": "uuid-or-null",
    "careActorId": null,
    "displayName": "Building Care"
  },
  "content": "Multiline operational note for technicians.\nAccess key held at Tower A engineering desk.",
  "idempotencyKey": "care-note-req-01-a",
  "createdAt": "2026-10-26T04:00:00.000Z",
  "replayed": false
}
```
- `GET` returns `data: HandymanInternalNote[]` in chronological order (`created_at ASC, id ASC`).

---

## 4. Internal Privacy and Non-Disclosure Guarantees

Internal notes carry `visibilityClassification: 'INTERNAL_ONLY'` and are never included in:
- customer-facing request APIs (`GET /api/v1/handyman/requests`, `GET /api/v1/handyman/requests/{handymanRequestId}`);
- tenant/customer portal endpoints (`/api/v1/tenant-service-requests`, `/api/v1/tenant-complaints`, `/api/v1/tenant-communications`);
- customer communication history (`/api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/communications`, `/api/v1/handyman/care/requests/{requestId}/communications`);
- quotation documents and read models (`/api/v1/handyman/requests/{handymanRequestId}/quotation/presented`, `/api/v1/handyman/quotation-versions/{id}`, `/api/v1/handyman/care/requests/{requestId}/projection`);
- BAST documents (`/api/v1/handyman/bast/{id}`, `/api/v1/handyman/execution-scopes/{id}/bast`);
- invoices and payment documents (`/api/v1/tenant-invoices`, `/api/v1/handyman/execution-scopes/{id}/customer-ledger`, `/api/v1/handyman/execution-scopes/{id}/invoice-reconciliation`);
- outbound customer notifications;
- public or customer-facing progress projections (`/api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/progress`, `/api/v1/handyman/requests/{handymanRequestId}/status-visibility`).

---

## 5. Idempotency and Partial-Success Recovery

1. Service request creation (`201`) commits in its own transaction with its structured `items` and `description`.
2. If subsequent internal note creation fails (validation error, network drop, or transient backend error), the committed service request and its structured items remain untouched.
3. Customer Care retries **only** `POST .../internal-notes` with the same `idempotencyKey`:
   - If the prior attempt did not commit, the retry creates the note (`201`, `replayed: false`).
   - If the prior attempt already committed with the same request and normalized content, the retry returns `200` with `replayed: true` and the original note without creating a duplicate.
   - If the same `idempotencyKey` is reused with different content or for a different request, the Backend returns `409 HANDYMAN_INTERNAL_NOTE_IDEMPOTENCY_CONFLICT`.

---

## 6. Extension Path for Future `UNLISTED_SERVICE` Intake Cases (STEP 5)

`handyman_internal_notes` is designed so future `UNLISTED_SERVICE` intake cases reuse the exact same note table and provenance model without duplicating the note system or rewriting historical notes:

1. **Attaching Notes to an Unlisted-Service Intake Case:**
   - When an unlisted-service intake case is created prior to catalog mapping, Customer Care records internal notes in `handyman_internal_notes` with:
     - `subject_type = 'UNLISTED_SERVICE_INTAKE_CASE'`
     - `unlisted_intake_case_id = <intakeCaseId>`
     - `handyman_request_id = NULL`
     - `client_id`, `tenant_company_id`, `building_id`, and `space_id` derived from the intake case's authoritative scope.
2. **Operations Triage Readback:**
   - During unlisted-service triage, Operations reads notes scoped to `(client_id, building_id, unlisted_intake_case_id)` ordered by `created_at ASC, id ASC` using existing narrow read permissions and BE-02G exact-Building enforcement.
3. **Post-Conversion Access from Service Request or Work Order:**
   - When Operations maps/converts an `UNLISTED_SERVICE` intake case into a catalog `handyman_service_requests` record (or downstream execution scope / work order), the conversion lineage records the originating `unlisted_intake_case_id` on the request/conversion link.
   - The service request (and linked work order) note reader queries:
     ```sql
     WHERE n.client_id = $1
       AND n.building_id = $2
       AND (
         n.handyman_request_id = $3
         OR ($4::uuid IS NOT NULL AND n.unlisted_intake_case_id = $4)
       )
     ORDER BY n.created_at ASC, n.id ASC
     ```
4. **Preserving Historical Provenance Without Copying or Rewriting:**
   - Because `handyman_internal_notes` is append-only (`trg_handyman_internal_notes_immutable`), pre-conversion notes remain untouched with their original `id`, `subject_type = 'UNLISTED_SERVICE_INTAKE_CASE'`, `unlisted_intake_case_id`, `created_by_user_id` / `created_by_care_actor_id`, `created_at`, and `idempotency_key`.
   - Subsequent post-conversion notes append with `subject_type = 'SERVICE_REQUEST'` and `handyman_request_id = <requestId>`, yielding a single chronological timeline across intake triage and execution without copying or mutating any historical row.
