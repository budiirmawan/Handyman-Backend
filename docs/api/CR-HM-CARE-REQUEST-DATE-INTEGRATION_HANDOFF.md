# Care request date integration — exact Frontend handoff

2026-10-25 · `budiirmawan/Handyman-Backend` · branch `arena/3a9f4872-handyman-backend` · verified starting HEAD `be2cabacea5cdcfdbc44935f5743d40404e1ea61`.

**DONE: Backend Care intake → existing Scheduling Readiness.** This is a Backend contract/test handoff, not a claim that Frontend forms or Mobile UI were changed/deployed. No new endpoint, booking engine, assignment workflow, date column/table, persona, tenant login or BM permit API is required.

## 1. Shared date contract

Add the existing field names to the **existing request-creation POST**, not a second scheduling call:

```json
{
  "preferredWindowStart": "2031-12-10T10:00:00+07:00",
  "preferredWindowEnd": "2031-12-10T12:00:00+07:00"
}
```

- Both fields are optional **as a pair**. Omit both for the exact legacy no-date behavior. One missing field, explicit nulls, empty values, invalid/impossible dates, missing offsets, zero/reversed windows or non-string values are rejected.
- Accepted instants use `YYYY-MM-DDTHH:mm:ss[.SSS]Z` or an explicit `±HH:mm` offset; fractional seconds, when used, have 1–3 digits. End must be strictly later than start. Backend normalizes the instants to UTC ISO strings for persistence, responses and standalone idempotency comparison.
- Supply the tenant's requested endpoints; do not invent an end/duration, infer time from `createdAt`, send browser-local offsetless strings, or introduce `requestedDate`/`workDate` aliases.
- `timezone` is **not** an accepted input. Backend derives a configured valid IANA timezone and Building/Client scope from its authoritative request → attribution → Building → Property → Client chain. Missing/invalid Building timezone rejects a dated intake; no-date intake does not acquire that dependency.
- This is a **preference**, not tenant commercial approval, a confirmed visit, reservation, assignment, Surat Tugas, permit or execution authority. Existing Operations coordination, scheduling/availability and assignment guards remain responsible for confirmation. Existing Mobile consumes confirmed execution appointments and assignment IDs, not this preference ID.

## 2. Standalone Customer Care

**POST `/api/v1/handyman/care/buildings/{buildingId}/requests`**

Headers: `Authorization: Bearer <existing Care staff session>`, `Idempotency-Key: <stable unique submission key, 1–200 chars>`, `Content-Type: application/json`.

Authority remains the existing `handyman.care.building` permission plus the current exact Building assignment and tenant/unit scope. Do **not** grant `tenant_company.manage` or use a tenant/PIC login for this form.

```json
{
  "tenantCompanyId": "11111111-1111-4111-8111-111111111111",
  "spaceId": "33333333-3333-4333-8333-333333333333",
  "serviceCatalogId": "22222222-2222-4222-8222-222222222222",
  "description": "Leaking tap",
  "preferredWindowStart": "2031-12-10T10:00:00+07:00",
  "preferredWindowEnd": "2031-12-10T12:00:00+07:00"
}
```

The UUIDs/tokens in these examples are placeholders, not real credentials or records. Required body fields: `tenantCompanyId`, `serviceCatalogId`. Existing optional fields remain `tenantPicId`, `spaceId`, `serviceVariantId`, `description`, `approvalTenantCompanyId`, `costResponsibleTenantCompanyId`; the only new accepted inputs are the requested-window pair. PIC and party fields are represented-customer selections, never the acting identity. Optional description is trimmed/bounded to 1000 characters; empty standalone description retains its existing omitted-value behavior.

**201 response**, with the existing safe standalone projection (no Client/Tenant/PIC/creator/attribution identifier leakage):

```json
{
  "success": true,
  "data": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "buildingId": "44444444-4444-4444-8444-444444444444",
    "spaceId": "33333333-3333-4333-8333-333333333333",
    "serviceCatalogId": "22222222-2222-4222-8222-222222222222",
    "serviceVariantId": null,
    "description": "Leaking tap",
    "status": "INTAKE",
    "createdAt": "2026-10-25T08:00:00.000Z",
    "updatedAt": "2026-10-25T08:00:00.000Z",
    "schedulingReadiness": {
      "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "timezone": "Asia/Jakarta",
      "preferredWindowStart": "2031-12-10T03:00:00.000Z",
      "preferredWindowEnd": "2031-12-10T05:00:00.000Z",
      "status": "ACTIVE",
      "supersedesReadinessId": null
    }
  },
  "meta": {}
}
```

`spaceId`, `serviceVariantId` and `description` may be null. For no-date submissions, `schedulingReadiness` is **absent**, not null; the nine existing response fields remain unchanged.

**Idempotency:** same acting staff user + same key + equivalent normalized body returns the stored **201 data** and creates nothing twice, including concurrent requests. Equivalent offset representations of the same date instants compare equally. Changing/adding/removing dates with an already-successful key is `409 IDEMPOTENCY_CONFLICT`, not an edit or reschedule. Preserve the key for retries; use the existing Operations supersession workflow for later coordinated date changes. The creation response remains its original snapshot even if Operations later supersedes the preference.

## 3. BM-hosted / workspace Customer Care

Reuse the existing attested Care exchange flow. For a workspace, the existing **POST `/api/v1/handyman/care/properties/{propertyId}/create-exchanges`** uses the workspace bearer credential and unchanged selection body (`tenantCompanyId`, `buildingId`, optional `spaceId`). Put dates on the **request create below**, not on that exchange-selection body. Existing signed Care handoff exchanges also remain supported.

**POST `/api/v1/handyman/requests/care`** · `Content-Type: application/json`:

```json
{
  "exchangeToken": "<existing opaque single-use Care exchange>",
  "serviceCatalogId": "22222222-2222-4222-8222-222222222222",
  "description": "Leaking tap",
  "preferredWindowStart": "2031-12-10T10:00:00+07:00",
  "preferredWindowEnd": "2031-12-10T12:00:00+07:00"
}
```

Required: `exchangeToken` (1–512 characters), `serviceCatalogId`. Optional: `serviceVariantId`, `description` (1–1000 trimmed characters when supplied), and the paired dates. This route's acting credential remains the body exchange, **not** a tenant bearer/login, public attribution ID or caller-supplied User. No extra BM work-permit/API integration or local Care User is introduced.

**201 response** is `{ "success": true, "data": <existing public request>, "meta": {} }`. The exact existing request fields remain:

`id`, `clientId`, `channelAttributionId`, `tenantCompanyId`, `tenantPicId` (nullable), `buildingId`, `spaceId` (nullable), `serviceCatalogId`, `serviceVariantId` (nullable), `originChannel` (`BM_SUPER_APP`), `originReference` (nullable), `description` (nullable), `status` (`INTAKE`), `createdByUserId` (**null** for attested Care), `createdAt`, `updatedAt`.

Date-bearing creation additionally returns **the same six-field `schedulingReadiness` object shown in §2**. It contains no Client/customer/creator identifiers. With no dates that property is absent. The request ID and preference ID are distinct; neither is a Work Order, confirmed appointment or assignment ID.

The existing exchange remains single-use: one successful **201**, then **401** on reuse/expiry/invalidated authority, including concurrent attempts. Do not treat it as standalone header-key replay or silently obtain a fresh exchange to duplicate a successful submission. On an uncertain network outcome, use the existing authorized Care request discovery/read flow. No new idempotency or booking system was added.

## 4. Errors, atomicity and history

- `400 HANDYMAN_SCHEDULING_READINESS_WINDOW_INVALID`: bad/incomplete pair. `400 HANDYMAN_SCHEDULING_READINESS_TIMEZONE_UNAVAILABLE`: authoritative Building timezone is missing/invalid. Existing validation, authentication, catalogue, authorization and conflict errors otherwise retain their contracts.
- `clientId`, `timezone`, actor/creator fields, confirmed state and assignment/booking fields remain forbidden inputs. Standalone Building comes from the authorized path; BM-hosted customer/location/actor comes only from the verified exchange. The existing non-enumerating Building/Tenant/property/occupancy walls are unchanged.
- Request, initial preference, existing scheduling audit/notification and (where applicable) idempotency claim or exchange consumption share **one transaction**. Any creation/audit failure rolls the unit back; no request-only success or orphan preference is returned. A failed transaction does not poison a key or consume an exchange, subject to the original credential lifetime/security checks.
- No-date requests do not create preference rows or scheduling events. Existing generic local-User `POST /handyman/requests` is unchanged; do not switch Care forms to it.
- Later tenant-coordinated changes continue through existing Scheduling Readiness supersession: preserve the original row/date/creator as INACTIVE and link the new ACTIVE row with `supersedesReadinessId`. Care capture alone never changes a confirmed appointment or grants scheduling-management permission. Existing confirmed schedule, assignment/roster IDs and Mobile Surat Tugas remain untouched.

## 5. Necessary actor-provenance migration — not deployed

`0483_handyman_care_initial_scheduling_preference` changes **only the existing preference creator constraint/provenance guard**. No date column/table is added. The old mandatory local-User creator prevented valid BM-hosted Care intake; a narrowly guarded null creator is now permitted only for an original INTAKE request with immutable attested Care attribution, matching Client/Building and no predecessor/history. Standalone creation still records the authenticated staff User. BM-hosted creator is the existing Care actor on the request attribution and scheduling audit—never a borrowed PIC/admin/phantom User.

Creator rewrites, non-Care null actors, foreign-Client null actors and null-actor revisions are rejected; existing User FKs, ACTIVE uniqueness and history links remain. Down migration refuses while Care-owned history exists rather than deleting it or inventing users. This migration was tested **only on disposable PostgreSQL** and must be included in any separately approved rollout; no production migration/deployment was run here.

## 6. Validation and scope

**70 PASS / 0 FAIL / 0 SKIP**, seven focused files / six suites, `128004.067102 ms`, child exit `0`; disposable shared DB removed. **Typecheck PASS**, exit `0`, `27833 ms`; `git diff --check` PASS. Files: `handyman-care-request-create`, `handyman-care-tenant-request-gateway-http`, `handyman-care-workspace-create-exchange`, `handyman-care-request-date-contract`, `handyman-scheduling-readiness`, `handyman-scheduling-scope-guard`, `handyman-service-request-intake-scope-guard` (`tests/*.test.ts`).

Coverage includes no-date compatibility, dated intake in both credentials lanes, workspace-issued Care exchanges, no PIC/User impersonation, safe responses, timezone derivation/failure, invalid pairs/overrides, canonical date fingerprints, replay/concurrency, rollback of business/audit/credential/idempotency writes, nullable-creator database guards, safe rollback refusal, existing authorization and supersession. Existing Operations scheduling/assignment, Mobile/Surat Tugas, dispatch/execution, finance/QC/BAST writers were not changed. No full suite, deployment or PR. **Commit/push the same branch and STOP after this Part.**
