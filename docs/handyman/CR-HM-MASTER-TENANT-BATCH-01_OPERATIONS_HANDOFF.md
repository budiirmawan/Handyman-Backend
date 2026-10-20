# CR-HM-MASTER-TENANT-BATCH-01 — Operations Handoff

Audience: Handyman-Operations (BFF + admin UI). Backend branch
`arena/6853ae83-handyman-operations` (stacked on PR #44 `65da7d0`). OpenAPI:
`docs/api/CR-HM-MASTER-TENANT-BATCH-01_OPENAPI.yaml` in the Backend repo.

## 1. What is new (additive only)

1. **Tenant/PIC batch import** — upload → validate → preview → confirm →
   commit, with abort as the rollback of a staged batch. Per-row errors, dedup
   against the party master, idempotent retries, durable audit. Client-scoped
   under `/clients/{clientId}/tenant-imports` with the exact BE-14A permission
   pair (`tenant_company.manage` for writes, `tenant_company.read` for reads).
2. **Verification state** on the existing party/PIC masters
   (`verificationStatus`: `PENDING_VERIFICATION` | `VERIFIED` | `REJECTED`),
   changed ONLY through `POST /tenant-companies/{id}/verification` and
   `POST /tenant-pics/{id}/verification` (perm `tenant_company.manage`,
   audited). Existing rows default `VERIFIED` — existing screens keep working
   unchanged.

Nothing else changed: no new tables besides `tenant_import_batches` /
`tenant_import_rows` (migration `0457`), no changed endpoint, no changed
field semantics. `verificationStatus` is additive on
`GET/POST/PATCH /tenant-companies` and PIC projections; it is **not**
patchable (PATCH with it → 400, "use the verification action").

## 2. Flow for the admin UI

1. **Upload** `POST /clients/{clientId}/tenant-imports`
   ```json
   {
     "sourceName": "tenant-okt-2026.xlsx",
     "idempotencyKey": "ops-tenant-2026-10-batch-1",
     "rows": [ { "party": { ... }, "pics": [ ... ], "unitLinks": [ ... ] } ]
   }
   ```
   The BFF cannot carry XLSX — the **browser** parses the spreadsheet/CSV into
   `rows[]` (SheetJS etc.) and posts JSON. Response `201` carries the batch and
   per-row structural results. Repeat with the same `idempotencyKey` + same
   content → `200` + `replayed: true` (no second batch); different content →
   `409 TENANT_IMPORT_IDEMPOTENCY_CONFLICT`. Keep one key per physical file.
2. **Validate** `POST .../{batchId}/validate` — semantic per-row check against
   live masters (nothing written). Response rows carry `status`, `errorCode`,
   `errorMessage` and `outcome.plan` (CREATE/REUSE, SKIP, REPLACE) → drive the
   preview grid from this.
3. **Preview** `GET .../{batchId}?status=INVALID&page=…` — paginated rows for
   the error list and the plan review.
4. **Confirm** `POST .../{batchId}/confirm` — freezes the set (idempotent).
5. **Commit** `POST .../{batchId}/commit` — applies rows through the existing
   master services. Row outcomes: `COMMITTED` / `SKIPPED_EXISTS` (deduped) /
   `FAILED` (per-row error; siblings unaffected). Repeat commit = replay
   (`replayed: true`), never a double-apply. A crashed commit resumes safely:
   resolved rows are skipped, the rest continue.
6. **Abort** `POST .../{batchId}/abort` — rollback of a staged batch (nothing
   was created yet). `COMMITTED` batches cannot be aborted (history is never
   deleted).

## 3. Row schema (CSV/XLSX template mapping)

One row = one party (+PICs + optional Unit relations). Suggested template
columns → JSON path:

| CSV column | JSON | Notes |
|---|---|---|
| `external_ref` | `externalRef` | optional trace id |
| `tenant_code` | `party.tenantCode` | optional; omitted → derived `TEN-…` (stable) |
| `tenant_name` | `party.tenantName` | required |
| `party_kind` | `party.partyKind` | `INDIVIDUAL`\|`LEGAL_ENTITY` (default LEGAL_ENTITY) |
| `legal_name` | `party.legalName` | INDIVIDUAL rows must leave this empty |
| `id_doc_type` | `party.identityDocumentType` | KTP/PASSPORT/KITAS (INDIVIDUAL), NPWP/NIB (LEGAL) |
| `id_doc_number` | `party.identityDocumentNumber` | sent to Backend only; UI shows masked |
| `email`,`phone`,`address`,`status` | `party.*` | optional |
| `verification` | `verificationStatus` | `PENDING`→`PENDING_VERIFICATION` (default), `VERIFIED` |
| `pic_name`,`pic_email`,`pic_phone`,`pic_role`,`pic_primary` | `pics[0]` | extra PICs → extra JSON entries (≤10) |
| `building_id` | `unitLinks[].buildingId` | UUID |
| `unit_code` / `unit_id` | `unitLinks[].unitCode` / `unitId` | unit code within the Building |
| `relation` | `unitLinks[].relation` | **`TENANCY`** (occupancy), **`OWNER`**, **`OCCUPANT`**, **`PIC`** (unit party role) — four distinct meanings; map them explicitly in the UI |
| `effective_from` / `effective_until` | `unitLinks[].effectiveFrom/…` | ISO date-time; date-effective history |
| `replace_existing` | `unitLinks[].replaceExisting` | `true` hands the relation over (previous holder closed at the effective date, never deleted) |

Rules the UI must communicate before upload:

- A row **without** party data is refused (`PARTY_REQUIRED`) — a Unit with an
  unknown occupant simply stays unassigned. Never fill in a placeholder Tenant.
- `INDIVIDUAL` + `legalName` is refused (no fictitious company identity).
- Unknown Unit / foreign Client / other Building collapse into the same
  `APARTMENT_UNIT_NOT_FOUND` — do not probe.
- Rows are deduplicated by identity document (then tenantCode, then name+email);
  in-batch duplicates get `DUPLICATE_ROW` (first row wins).

## 4. Per-row error vocabulary (closed set)

`VALIDATION`, `PARTY_REQUIRED`, `DUPLICATE_ROW`, `DUPLICATE_PIC`,
`TENANT_IDENTITY_CONFLICT`, `BUILDING_ACCESS_DENIED`,
`APARTMENT_UNIT_NOT_FOUND`, `TENANT_SPACE_ALREADY_ASSIGNED`,
`UNIT_PARTY_ROLE_ALREADY_ACTIVE`, `TENANT_COMPANY_INACTIVE`, `COMMIT_FAILED`
(`COMMIT_FAILED` = commit phase only).

Batch-level errors: `TENANT_IMPORT_NOT_FOUND` (404),
`TENANT_IMPORT_STATE_CONFLICT` (409), `TENANT_IMPORT_IDEMPOTENCY_CONFLICT`
(409), `TENANT_IMPORT_EMPTY` (400), plus the standard `VALIDATION_ERROR`.

## 5. Verification & authority (what the UI must show)

- New imports default to **`PENDING_VERIFICATION`** (temporary registration).
  Show it as a badge in the Tenant/PIC directory; existing parties show
  `VERIFIED`.
- Unverified data has **no approval authority and no billing authority**:
  Customer Care request creation with an unverified approval/cost party is
  refused with `409 TENANT_VERIFICATION_REQUIRED` (both for default parties
  and explicit designations). That is intentional policy (the CR's red line).
- Verdicts only via the verification actions (with optional audit note in the
  body later if needed — today `{"status":"VERIFIED"}`), each transition audited
  (`TENANT_VERIFICATION_UPDATED`).
- `REJECTED` is settable only through the action (never at create/import).

## 6. Auth matrix (fail-closed, unchanged semantics)

| Endpoint | Permission | Reach |
|---|---|---|
| `POST/GET /clients/{id}/tenant-imports`, `GET …/{batchId}` | manage / read / read | `canAccessClient` (BE-02 Building-assignment chain) |
| `POST …/validate\|confirm\|commit\|abort` | manage | same |
| `POST /tenant-companies/{id}/verification`, `/tenant-pics/{id}/verification` | `tenant_company.manage` | same |

No new permission code was introduced. Cross-Building access is **never**
expanded (see `CR-HM-MASTER-TENANT-BATCH-01_INVESTIGATION.md`).

## 7. BFF additions (mirror BE-14A patterns)

Extend the closed allow-list in `api/admin/master-data.ts` with
`/clients/{clientId}/tenant-imports*` and the two verification actions —
same `forward()` + same-origin CSRF + pass-through error envelope. Do not
build a new authentication path. Remember the BFF error gate: new Backend
error codes must be echoed with their code/category/retryable exactly as the
pass-through does today (no re-mapping).

## 8. Investigation summary (root causes)

- `NOT_FOUND` on Unit/service-catalogue reads: those routes exist only on
  Backend PR #44 (unmerged); `main`'s fall-through 404 is working as designed.
  Resolution = human merge of PR #44. BFF paths already match.
- `BUILDING_ACCESS_DENIED` in the Tenant directory: `resolveBuildingsForUser`
  grants Building reach only via ACTIVE Building assignments (BE-02 "no
  same-Client shortcut"). Working as designed — provision assignments (or
  clarify UX); never widen access. Details and evidence:
  `docs/handyman/CR-HM-MASTER-TENANT-BATCH-01_INVESTIGATION.md` (Backend repo).

## 9. Known gaps (this CR, by decision)

- XLSX/CSV parsing itself is Frontend-side (the Backend accepts JSON rows).
- Row-level batch atomicity is per-row by design: reused master services own
  their own transactions; each row's outcome is recorded, failures are
  isolated, retries converge. No cross-row rollback exists — use `abort`
  before commit instead.
- Imported rows never UPDATE an existing master row (REUSE only). Identity↔code
  contradictions surface as `TENANT_IDENTITY_CONFLICT` for manual resolution.
- `tenant_building_contexts` (BE-14D) is unchanged: create it via the existing
  endpoint when a Tenant starts operating in a Building (the Care gateway
  still requires it).
