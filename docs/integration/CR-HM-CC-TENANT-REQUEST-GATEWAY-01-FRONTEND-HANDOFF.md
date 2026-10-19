# Handyman Customer Care — Staff-Assisted Tenant Request Gateway (Frontend Contract)

**Change:** `CR-HM-CC-TENANT-REQUEST-GATEWAY-01`
**Contract owner:** Handyman Backend
**Consumer:** Handyman-Frontend PR #30
**Stage:** Stage 1 — Customer Care signs in directly to Handyman Frontend with a Backend user account. The BM Super App exchange intake (`POST /api/v1/handyman/requests/care`) and the BM-hosted Care workspace remain separate and unchanged.
**Base path:** `/api/v1`
**Companion read contract:** `HANDOFF_HANDYMAN_CARE_STANDALONE_DISCOVERY.md` (CR-HM-BM-CARE-DISCOVERY-01) — building discovery, request list/detail/progress readers are unchanged.
**OpenAPI:** `docs/api/openapi.yaml` (tags `Customer Care Discovery`).

This file is portable for the Frontend consumer. It documents the Backend contract and does not prescribe Frontend routes.

## 1. What this enables

An authenticated CUSTOMER_CARE staff member selects an authorized Tenant/Unit and creates **the canonical Handyman Request** on the Tenant's behalf, using the existing Backend Bearer session. The Backend:

- persists the authoritative `handyman_service_requests` row (the same record Handyman Operations triages — no second request system, no `tenant-companies/{id}/service-requests` substitute);
- issues the request UUID and the initial `INTAKE` lifecycle state;
- records the represented Tenant/PIC **separately** from the actual creator (`createdByUserId` = the staff session user, never the customer);
- records channel/source attribution as `originChannel = CUSTOMER_CARE_BACKEND` (no BM credential, no `hcw_` session, no impersonation);
- makes the same request id immediately visible in the Operations intake queue.

## 2. Authentication and authority

1. `POST /api/v1/auth/login` with the staff member's Backend credentials; read `data.sessionToken`.
2. Send `Authorization: Bearer <sessionToken>` on every request.

Every gateway route additionally requires:

- a valid, unexpired Backend session for an ACTIVE user;
- the dedicated `handyman.care.building` permission (`tenant_company.read`/`tenant_company.manage` are not substitutes and are not additionally required);
- an ACTIVE assignment to the **exact** selected Building, with an ACTIVE Building → Property → Client lineage (Client is derived server-side).

The endpoints never accept a BM token, a `hcw_` workspace token, a Tenant login, or a caller-supplied Client/actor identity. Presenting a recording identity (`recordedByUserId`, `actorUserId`, `careActorId`, `tenantId`, …) is a rejected `400`, not a silently-ignored field. `tenantPicId` is accepted **only** as the represented-customer selection (validated server-side as an ACTIVE PIC of the selected tenant) and can never become the acting identity.

## 3. Selection readers (Tower → Floor → Unit, Tenant/PIC, catalogue)

All are `GET`, require the authority from §2, return `Cache-Control: no-store`, reject unknown query keys and non-empty bodies with `400`, and are scoped by the server-derived Client — a sibling Building in the same Client is not sufficient (`403 HANDYMAN_CARE_AUTHORITY_DENIED`).

| Step | Route | Query |
|---|---|---|
| 1. Buildings (tower scope) | `GET /handyman/care/buildings` | — |
| 2. Tenants + PICs | `GET /handyman/care/buildings/{buildingId}/tenants` | — |
| 3. Floors | `GET /handyman/care/buildings/{buildingId}/floors` | — |
| 4. Eligible Units | `GET /handyman/care/buildings/{buildingId}/units` | `tenantCompanyId` **required**, `floorId` optional |
| 5. Service catalogue | `GET /handyman/care/buildings/{buildingId}/catalogue/services` | — |

### Tenant/PIC discovery — `GET /handyman/care/buildings/{buildingId}/tenants`

```json
{
  "success": true,
  "data": [
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "tenantCode": "TEN-001",
      "tenantName": "Example Tenant",
      "pics": [
        { "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "picName": "Jane Doe", "isPrimary": true }
      ]
    }
  ],
  "meta": {}
}
```

Only ACTIVE Tenants with an ACTIVE, currently-effective Building context are listed; only ACTIVE PICs are nested (no linked user ids, no contact PII). This list **is** the eligibility contract — anything listed can be submitted to the create endpoint.

### Floors — `GET /handyman/care/buildings/{buildingId}/floors`

```json
{ "success": true, "data": [ { "id": "…", "code": "L01", "name": "Level 1", "levelNumber": 1 } ], "meta": {} }
```

### Units — `GET /handyman/care/buildings/{buildingId}/units?tenantCompanyId=…&floorId=…`

```json
{
  "success": true,
  "data": [
    {
      "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "code": "SP-01", "name": "Suite 01",
      "floorId": "…", "floorCode": "L01", "levelNumber": 1,
      "roomId": "…", "roomCode": "R-01"
    }
  ],
  "meta": {}
}
```

Unit id = the existing `spaces.id` (submitted as `spaceId`). Only Units whose ACTIVE, currently-effective tenant relationship and full ACTIVE Space → Room → Area → Floor chain resolve inside the Building for that tenant are returned. An unknown/foreign `tenantCompanyId` fails with the same non-enumerating `403` as the create endpoint.

### Catalogue — `GET /handyman/care/buildings/{buildingId}/catalogue/services`

Same item shape as `GET /handyman/catalogue/services`: `data: [{ service: ServiceCatalogEntry, variants: HandymanServiceVariant[] }]`, ACTIVE only, Client derived server-side. This is the authorized pool for `serviceCatalogId`/`serviceVariantId`.

## 4. Create — `POST /handyman/care/buildings/{buildingId}/requests`

**Headers**

- `Authorization: Bearer <sessionToken>` — required.
- `Idempotency-Key` — **required** (≤ 200 chars, trimmed, CR/LF/NUL rejected; missing → `400 IDEMPOTENCY_KEY_REQUIRED`). Scoped to actor + operation: identical key + identical body replays the original `201` with no new rows; same key + different body → `409 IDEMPOTENCY_CONFLICT`.

**Request body** (JSON; unknown fields rejected `400`)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `tenantCompanyId` | uuid | yes | Represented Tenant from the tenants reader (must hold an ACTIVE context in this Building under the derived Client). |
| `serviceCatalogId` | uuid | yes | ACTIVE service of the derived Client from the catalogue reader. |
| `tenantPicId` | uuid | no | Represented PIC of that tenant (ACTIVE). Persisted as the represented customer — never as the creator. |
| `spaceId` | uuid | no | Unit from the units reader (active tenant relationship in this Building). |
| `serviceVariantId` | uuid | no | ACTIVE variant of the selected service. |
| `description` | string 1–1000 | no | Problem description (trimmed). |

```json
{
  "tenantCompanyId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "tenantPicId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "spaceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "serviceCatalogId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "description": "Leaking tap in the unit bathroom"
}
```

**Success — `201`** (identical body returned on idempotent replay; `Cache-Control: no-store`)

```json
{
  "success": true,
  "data": {
    "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "buildingId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "spaceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "serviceCatalogId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "serviceVariantId": null,
    "description": "Leaking tap in the unit bathroom",
    "status": "INTAKE",
    "createdAt": "2026-10-19T08:00:00.000Z",
    "updatedAt": "2026-10-19T08:00:00.000Z"
  },
  "meta": {}
}
```

The projection is the same allow-list as the discovery readers — Client/Tenant/PIC/creator/attribution ids are deliberately not echoed (the Frontend already holds its own selections). `data.id` is the Backend-issued request id to display and to use on every follow-up read.

## 5. After creation

1. **Operations handoff is automatic.** The persisted row is the canonical Handyman Request: the same id appears in the authorized Operations intake/triage queue (`GET /handyman/operations/queue`). There is no forward action to call, no second record to create, and no duplicate to avoid — Customer Care only receives the Backend-issued id.
2. **Care reads progress** with the unchanged discovery readers:
   - `GET /handyman/care/buildings/{buildingId}/requests/{requestId}`
   - `GET /handyman/care/buildings/{buildingId}/requests/{requestId}/progress`
3. **Care cannot perform technical triage.** Lifecycle transitions live behind their own permissions (`POST /handyman/requests/{requestId}/triage` requires `tenant_company.manage`) and return `403 PERMISSION_DENIED` to a Care-only session. Do not build any Care UI for triage/inspection/diagnosis/quotation decisions — reads only (Authority B stays blocked).
4. **Evidence attachment** (INTAKE stage only, same policy as the customer surface — multipart field `file`, `evidenceKind` `PHOTO|VIDEO`, ≤ 50 MB):
   - `POST /handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` → `201 HandymanIntakeEvidence`
   - `GET /handyman/care/buildings/{buildingId}/requests/{requestId}/intake-evidence` → metadata list
   The recorder persisted is the staff session user; uploading never changes the request status.

## 6. Errors

Standard Backend envelope (`success: false`, `error.code`, `error.category`, `retryable`).

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Malformed UUID, unknown body/query field, bad description, or identity-spoof field (`HANDYMAN_CARE_IDENTITY_NOT_ACCEPTED` for recording-identity spellings). |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | Missing/blank `Idempotency-Key`. |
| `400` | `HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH` | `spaceId` has no active tenant relationship in this Building. |
| `400` | `HANDYMAN_CHANNEL_ATTRIBUTION_REQUESTER_INVALID` | `tenantPicId` is not an ACTIVE PIC of the tenant. |
| `400` | `HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH` | `serviceCatalogId`/`serviceVariantId` outside the derived Client/parent service. |
| `401` | `AUTHENTICATION_REQUIRED` / `INVALID_SESSION` / `SESSION_EXPIRED` | Missing, invalid or expired Backend session. |
| `403` | `PERMISSION_DENIED` | Session lacks `handyman.care.building` (or `tenant_company.manage` on lifecycle routes). |
| `403` | `HANDYMAN_CARE_AUTHORITY_DENIED` | Not ACTIVE/assigned to this exact Building, lineage unavailable, or the submitted Tenant is unknown/cross-Client/bound to another Building. Non-enumerating: unknown and wrong-scope look identical. |
| `404` | `SERVICE_CATALOG_NOT_FOUND` | Unknown `serviceCatalogId`. |
| `404` | `HANDYMAN_SERVICE_REQUEST_NOT_FOUND` | Request absent or outside the selected Building/Client. |
| `409` | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key`, different submission. |
| `409` | `HANDYMAN_SERVICE_REQUEST_ALREADY_EXISTS` | One request per immutable channel attribution (safety wall). |

## 7. Explicit non-goals

- No BM HMAC/exchange credentials, `hcw_` workspace tokens, or BM SSO exchange are used or minted.
- No quotation/variation/BAST decision, payment verification, Work Order mutation, or lifecycle transition is added for Customer Care.
- No schema change is required from the Frontend beyond reading the new endpoints; the only storage change is the additive widening of the origin-channel vocabulary to `CUSTOMER_CARE_BACKEND` (migration `0455`), which is invisible to consumers.
