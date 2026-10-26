# CR-HM-CARE-UNLISTED-INTAKE — PART 01: Unlisted Service Intake + Internal Notes

- **Date:** 2026-10-26 (Asia/Jakarta)
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch:** `arena/9fdd2eb4-handyman-backend`
- **Feature Baseline Commit:** `6509b0b4248e3b945940d0080caafc8faaf25d5b` (`CR-HM-CARE-INTERNAL-NOTES-01` PART 01)
- **Frontend Consumer:** `arena/3943cfe0-handyman-frontend` @ `79bd96734cf69a741653e28a054350ee97b8c587`
- **Migration Identifier:** `0486_handyman_unlisted_service_intake_cases`

---

## 1. Objective and Scope

Allows Customer Care to register customer requests for services that are not available in the global or Client-specific Service Catalog, with optional secure Internal Notes, without requiring a fake `serviceCatalogId`, placeholder service, or incorrect catalog selection.

The 24 global starter services and existing catalog-based request workflows remain completely unchanged.

---

## 2. Unlisted Service Intake Data Model (`0486_handyman_unlisted_service_intake_cases`)

Table: `handyman_unlisted_service_intake_cases`

| Column | Type | Constraints / Purpose |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | Unique unlisted-service intake case identifier |
| `client_id` | `UUID NOT NULL REFERENCES clients(id)` | Server-derived Client scope |
| `building_id` | `UUID NOT NULL REFERENCES buildings(id)` | Server-derived Building scope |
| `space_id` | `UUID NULL REFERENCES spaces(id)` | Optional Unit/Space scope |
| `tenant_company_id` | `UUID NOT NULL REFERENCES tenant_companies(id)` | Customer Tenant Company context |
| `tenant_pic_id` | `UUID NULL REFERENCES tenant_pics(id)` | Optional Customer Tenant PIC context |
| `approval_tenant_company_id` | `UUID NOT NULL REFERENCES tenant_companies(id)` | Authorized commercial approval party (defaults to `tenant_company_id`) |
| `cost_responsible_tenant_company_id` | `UUID NOT NULL REFERENCES tenant_companies(id)` | Authorized cost-responsible party (defaults to `tenant_company_id`) |
| `channel_attribution_id` | `UUID NULL UNIQUE REFERENCES handyman_channel_attributions(id)` | Immutable channel attribution provenance |
| `origin_channel` | `TEXT NOT NULL` | `CHECK (origin_channel IN ('CUSTOMER_CARE_BACKEND', 'BM_SUPER_APP'))` |
| `origin_reference` | `TEXT NULL` | Server-derived external origin reference |
| `requested_service_name` | `TEXT NOT NULL` | Free-text requested service name (`1..250` chars trimmed; no `serviceCatalogId`) |
| `description` | `TEXT NOT NULL` | Customer complaint / description (`1..2000` chars trimmed) |
| `preferred_window_start` | `TIMESTAMPTZ NULL` | Optional preferred visit window start (preference only) |
| `preferred_window_end` | `TIMESTAMPTZ NULL` | Optional preferred visit window end (preference only) |
| `preferred_window_timezone` | `TEXT NULL` | Server-derived Building IANA timezone when preferred window is provided |
| `status` | `TEXT NOT NULL DEFAULT 'PENDING_TRIAGE'` | `CHECK (status IN ('PENDING_TRIAGE'))` — creation state only; widened by 0487 (CR-HM-MANUAL-QUOTATION-01 PART 01) with the five Operations triage outcomes |
| `created_by_user_id` | `UUID NULL REFERENCES users(id)` | Authenticated Customer Care staff user (`num_nonnulls(created_by_user_id, created_by_care_actor_id) = 1`) |
| `created_by_care_actor_id` | `UUID NULL REFERENCES handyman_handoff_care_actors(id)` | Attested BM Care Workspace actor |
| `idempotency_key` | `TEXT NOT NULL` | Trimmed `1..200` chars; unique per `(created_by_user_id, idempotency_key)` and `(created_by_care_actor_id, idempotency_key)` |
| `payload_hash` | `TEXT NOT NULL` | Canonical SHA-256 hex digest of normalized intake payload |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Server-recorded creation timestamp |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Server-recorded update timestamp |

### Database Triggers & Constraints
1. **`trg_handyman_unlisted_intake_guard_insert` (`BEFORE INSERT`)**:
   - Verifies `building_id` belongs to a Property owned by `client_id`.
   - Verifies `tenant_company_id`, `approval_tenant_company_id`, and `cost_responsible_tenant_company_id` belong to `client_id`.
   - Verifies `space_id` (when provided) belongs to `building_id`.
   - Verifies `tenant_pic_id` (when provided) belongs to `tenant_company_id`.
   - Verifies `channel_attribution_id` (when provided) matches `(client_id, tenant_company_id, building_id, space_id)`.
   - Rejects any `created_by_user_id` linked to `tenant_pics` (`23514`).
2. **`trg_handyman_unlisted_intake_guard_mutation` (`BEFORE UPDATE OR DELETE`)**:
   - Rejects `DELETE` (`23514`) and rejects any `UPDATE` of immutable intake fields or provenance (`23514`).

---

## 3. Internal Notes Integration (STEP 2)

Reuses the existing `handyman_internal_notes` table introduced in migration `0485`:
- Uses `subject_type = 'UNLISTED_SERVICE_INTAKE_CASE'`, `unlisted_intake_case_id = <intakeCaseId>`, and `handyman_request_id = NULL`.
- Migration `0486` adds:
  - `handyman_internal_notes_unlisted_intake_case_id_fkey`: `FOREIGN KEY (unlisted_intake_case_id) REFERENCES handyman_unlisted_service_intake_cases (id) ON DELETE RESTRICT`
  - `handyman_internal_notes_unlisted_intake_scope_fkey`: `FOREIGN KEY (unlisted_intake_case_id, client_id, building_id) REFERENCES handyman_unlisted_service_intake_cases (id, client_id, building_id) ON DELETE RESTRICT`
  - Updated `handyman_internal_notes_guard_insert()` trigger function verifying that `client_id`, `tenant_company_id`, `building_id`, and `space_id` on `UNLISTED_SERVICE_INTAKE_CASE` notes match the authoritative `handyman_unlisted_service_intake_cases` row.
- Preserves `visibility_classification = 'INTERNAL_ONLY'`, append-only immutability (`trg_handyman_internal_notes_immutable`), author identity (`CUSTOMER_CARE` / `OPERATIONS`), server timestamps, and idempotency (`200` on replay, `409 HANDYMAN_INTERNAL_NOTE_IDEMPOTENCY_CONFLICT` on payload mismatch).
- Never copies internal notes to customer communications, quotations, BAST, invoices, or external/customer-facing documents.

---

## 4. API Endpoints (STEP 3)

All endpoints are mounted under `/api/v1` and return `Cache-Control: no-store`.

### 4.1 Unlisted Service Intake Case Endpoints

| Method | Path | Primary Consumer | Auth & Scope Gate |
|---|---|---|---|
| `POST` | `/handyman/care/buildings/{buildingId}/unlisted-intake-cases` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `GET` | `/handyman/care/buildings/{buildingId}/unlisted-intake-cases` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `GET` | `/handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `POST` | `/handyman/care/unlisted-intake-cases` | Care Workspace / Care Session | `Bearer hcw_...` workspace token, `exchangeToken` in body, or Care session (`handyman.care.building` + exact Building) |
| `GET` | `/handyman/care/unlisted-intake-cases` | Care Workspace / Care Session | `Bearer hcw_...` workspace token or Care session |
| `GET` | `/handyman/care/unlisted-intake-cases/{intakeCaseId}` | Care Workspace / Care Session | `Bearer hcw_...` workspace token or Care session |
| `GET` | `/handyman/operations/unlisted-intake-cases` | Handyman Operations | Bearer session + `service_request.read` / `work_order.read` / non-PIC `tenant_company.read` + exact Building assignment (BE-02G) |
| `GET` | `/handyman/unlisted-intake-cases/{intakeCaseId}` | Operations & Customer Care | Bearer session (`service_request.read` / `work_order.read` / non-PIC `tenant_company.read` / `handyman.care.building`) or `Bearer hcw_...` + exact Building scope |

### 4.2 Unlisted Service Intake Internal Notes Endpoints

| Method | Path | Primary Consumer | Auth & Scope Gate |
|---|---|---|---|
| `POST` | `/handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}/internal-notes` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `GET` | `/handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}/internal-notes` | Standalone Customer Care | Bearer session + `handyman.care.building` + Authority A for exact `buildingId`; non-PIC |
| `POST` | `/handyman/care/unlisted-intake-cases/{intakeCaseId}/internal-notes` | Care Workspace / Care Session | `Bearer hcw_...` workspace token or Care session (`handyman.care.building` + exact Building) |
| `GET` | `/handyman/care/unlisted-intake-cases/{intakeCaseId}/internal-notes` | Care Workspace / Care Session | `Bearer hcw_...` workspace token or Care session |
| `POST` | `/handyman/unlisted-intake-cases/{intakeCaseId}/internal-notes` | Customer Care & Operations | Care (`handyman.care.building` / `hcw_...`) or Operations (`service_request.manage` / `work_order.manage` / internal `tenant_company.manage`) + exact Building scope |
| `GET` | `/handyman/unlisted-intake-cases/{intakeCaseId}/internal-notes` | Customer Care & Operations | Care (`handyman.care.building` / `hcw_...`) or Operations (`service_request.read` / `work_order.read` / non-PIC `tenant_company.read`) + exact Building scope |

*(Note: The existing `/handyman/care/buildings/{buildingId}/requests/{requestId}/internal-notes`, `/handyman/care/requests/{requestId}/internal-notes`, and `/handyman/requests/{handymanRequestId}/internal-notes` routes also transparently resolve an `intakeCaseId` when passed to them.)*

### 4.3 Partial-Success & Note-Only Retry Behavior
1. Intake creation commits in its own transaction (`201 Created`, status `PENDING_TRIAGE`).
2. Whether internal notes are submitted in a subsequent `POST .../internal-notes` call or via the optional inline `internalNote` field on `POST .../unlisted-intake-cases`, any note validation or write failure preserves the committed intake case and its `id` (included in `error.resource.id` and `error.details` when an inline note fails).
3. Customer Care retries **only** the note creation (`POST .../unlisted-intake-cases/{intakeCaseId}/internal-notes`) using the note's `idempotencyKey`, without recreating or mutating the unlisted intake case.

---

## 5. Operations Handoff and Future Triage Decisions (STEP 4)

New unlisted-service intake cases are immediately visible to authorized Handyman Operations personnel via `GET /api/v1/handyman/operations/unlisted-intake-cases` (default filter `status = 'PENDING_TRIAGE'`) and `GET /api/v1/handyman/unlisted-intake-cases/{intakeCaseId}`, including all chronological `internalNotes`.

### Documented Future Triage Decisions (`HANDYMAN_UNLISTED_INTAKE_FUTURE_TRIAGE_DECISIONS`)

> **Status (CR-HM-MANUAL-QUOTATION-01 PART 01).** This section is the PART 01
> forecast, kept verbatim for history, and is now IMPLEMENTED with one
> correction: triage never creates a `service_catalog` row (item 2 below) — it
> records the Client-custom requirement as an immutable decision, and the
> governed catalog administration stays where it always was. The implemented
> decision set is the four forecasts plus
> `ONE_TIME_MANUAL_QUOTATION_REQUIRED`, each projecting exactly one case
> status; `REQUEST_MORE_INFORMATION_OR_INSPECTION` is allowed exactly once per
> case and never becomes the case's effective decision. Conversion into a formal
> `handyman_service_requests` record (items 1–2) is NOT implemented here — see
> `docs/handyman/CR-HM-MANUAL-QUOTATION-01_PART-01.md` §5 for the exact PART 02
> contract.

Authorized Operations personnel adjudicate a `PENDING_TRIAGE` unlisted intake case using one of four governed decisions:

1. **`MATCH_EXISTING_CATALOG_SERVICE` (Match existing catalog service):**
   - Operations maps the unlisted request to an existing active `service_catalog` entry (and optional `handyman_service_variants` row) for the Client, creating/linking the formal `handyman_service_requests` record while preserving the originating `unlisted_intake_case_id` and its historical internal notes without copying or rewriting them.
2. **`CREATE_CLIENT_CUSTOM_SERVICE` (Create Client-specific custom service):**
   - Operations creates a Client-scoped custom service entry in `service_catalog` (without modifying the 24 global starter services) and converts the intake case into a formal catalog-backed `handyman_service_requests` record linked to `unlisted_intake_case_id`.
3. **`REQUEST_MORE_INFORMATION_OR_INSPECTION` (Request more information or inspection):**
   - Operations appends an internal note or coordinates through Customer Care / site inspection when technical specifications or site conditions must be clarified before catalog mapping or quotation.
4. **`REJECT_UNSUPPORTED` (Reject as unsupported):**
   - Operations records a governed rejection reason when the requested work falls outside supported Handyman capabilities or building regulations, preserving full audit and note provenance.
