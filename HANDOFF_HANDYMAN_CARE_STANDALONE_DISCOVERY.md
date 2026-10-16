# Handyman Customer Care — Standalone Discovery Contract

**Change:** `CR-HM-BM-CARE-DISCOVERY-01`
**Contract owner:** Handyman Backend
**Stage:** Stage 1 — Customer Care signs in directly to Handyman Frontend with a Backend user account. Stage 2 — BM Super App integration remains separate and unchanged.
**Base path:** `/api/v1`
**Access:** Backend session + `handyman.care.building` + ACTIVE assignment to the exact ACTIVE Building.

This file is portable for the Frontend consumer. It documents the Backend contract and does not prescribe or change Frontend routes.

## 1. Authentication and authority

Use the existing Backend credential/session flow:

1. `POST /api/v1/auth/login` with the user's Backend credentials.
2. Read `data.sessionToken` from the standard success envelope.
3. Send `Authorization: Bearer <sessionToken>` on each discovery request.
4. Use the existing `POST /api/v1/auth/logout` when the Backend session should be revoked.

The discovery endpoints do **not** accept a BM token, a `hcw_` workspace token, BM bootstrap/SSO credentials, Tenant login, or Tenant impersonation. Do not forward a Client ID, actor ID, Tenant/PIC identity, or other recording identity as an authority input. The Backend derives Client from the authenticated user's exact active Building assignment and its Building → Property → Client chain.

Every discovery request requires all of the following:

- A valid, unexpired Backend session for an ACTIVE user.
- The dedicated `handyman.care.building` permission. `tenant_company.read` and `tenant_company.manage` are not substitutes and are not additionally required by these endpoints.
- An ACTIVE assignment to the exact selected Building.
- An ACTIVE Building, Property, and Client lineage.
- The request row's authoritative Client, Building, Tenant Company, and attribution ownership to match. A sibling Building in the same Client is not sufficient.

The endpoints are read-only. They do not create/approve quotations, authorize variations, accept/reject BAST, verify payments, close Work Orders, execute Tenant decisions, or exchange BM SSO credentials.

## 2. Routes

All routes below are `GET` and return `Cache-Control: no-store`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/handyman/care/buildings` | List the caller's exact active, assigned Building scopes. |
| `GET` | `/api/v1/handyman/care/buildings/{buildingId}/requests` | List requests belonging to the selected Building and server-derived Client. |
| `GET` | `/api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}` | Open one request in that exact Building and return its safe progress projection. |
| `GET` | `/api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/progress` | Return only request ID/status and the same safe progress projection. |

`buildingId`, `requestId`, and optional `spaceId` are UUIDs. Requests outside the selected Building/Client are not disclosed; a detail lookup returns the standard request-not-found response.

### Request-list query

Accepted query keys:

- `status` — one of `INTAKE`, `TRIAGE`, `INSPECTION_REQUIRED`, `DIAGNOSIS`, `READY_FOR_NEXT_STEP`, `REFERRED`.
- `spaceId` — optional exact space filter.
- `page`, `pageSize` — optional shared pagination. If neither is present, the existing unpaginated list contract is used. If either is present, `page` defaults to `1`, `pageSize` defaults to `50`, and `pageSize` must be `1..200`.

Unknown query keys (including `clientId` or actor/tenant identity fields), malformed values, and non-empty GET bodies are rejected with `400`. No caller-supplied Client can broaden or redirect scope.

When pagination is enabled, `meta` is `{ "page": number, "pageSize": number, "total": number, "totalPages": number }`; otherwise the standard empty `meta` object is returned. Unsafe integer page/offset values are rejected. Requests are ordered newest-first by `createdAt`, with request ID as the deterministic tie-breaker.

## 3. Response contracts

All successful responses use the Backend envelope:

```json
{ "success": true, "data": {}, "meta": {} }
```

### Assigned Buildings

`GET /api/v1/handyman/care/buildings`

```json
{
  "success": true,
  "data": [
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "code": "BLD-JKT-01",
      "name": "Jakarta Building",
      "property": {
        "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "code": "PROP-JKT",
        "name": "Jakarta Property"
      }
    }
  ],
  "meta": {}
}
```

Only Buildings from the authenticated user's active assignment set and active lineage are returned. Client IDs, assignment IDs, and personnel identifiers are not included.

### Request list

`GET /api/v1/handyman/care/buildings/{buildingId}/requests?page=1&pageSize=50`

```json
{
  "success": true,
  "data": [
    {
      "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "buildingId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "spaceId": null,
      "serviceCatalogId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "serviceVariantId": null,
      "description": "Repair the leaking tap",
      "status": "INTAKE",
      "createdAt": "2026-10-16T08:00:00.000Z",
      "updatedAt": "2026-10-16T08:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "pageSize": 50, "total": 1, "totalPages": 1 }
}
```

The response is an allow-list. It does not serialize the canonical request row wholesale; it omits Client/Tenant/PIC/creator IDs, attribution provenance, and unrelated records.

### Request detail

`GET /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}`

```json
{
  "success": true,
  "data": {
    "request": {
      "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "buildingId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "spaceId": null,
      "serviceCatalogId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "serviceVariantId": null,
      "description": "Repair the leaking tap",
      "status": "INTAKE",
      "createdAt": "2026-10-16T08:00:00.000Z",
      "updatedAt": "2026-10-16T08:00:00.000Z"
    },
    "progress": {
      "triage": null,
      "inspection": null,
      "diagnosis": null,
      "quotation": null,
      "execution": null
    }
  },
  "meta": {}
}
```

A `null` triage, inspection, diagnosis, or quotation means the corresponding optional read returned no record. `execution: null` means the request has no authoritative execution-scope link.

### Safe progress

`GET /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/progress`

```json
{
  "success": true,
  "data": {
    "requestId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "status": "READY_FOR_NEXT_STEP",
    "progress": {
      "triage": {
        "disposition": "INSPECTION_REQUIRED",
        "recordedAt": "2026-10-16T08:05:00.000Z"
      },
      "inspection": {
        "result": "INSPECTED",
        "inspectedAt": "2026-10-16T08:10:00.000Z"
      },
      "diagnosis": {
        "scopeClassification": "GENERAL_HANDYMAN",
        "diagnosedAt": "2026-10-16T08:15:00.000Z"
      },
      "quotation": {
        "versions": [
          {
            "versionNumber": 1,
            "status": "APPROVED",
            "updatedAt": "2026-10-16T08:20:00.000Z"
          }
        ]
      },
      "execution": {
        "scopeVariations": [],
        "dispatchRelease": null,
        "workSessions": [],
        "qualityControlRuns": [],
        "bast": null,
        "paymentStatuses": null,
        "warranty": null
      }
    }
  },
  "meta": {}
}
```

The fields under `progress` are bounded projections of existing Backend read services. Their actual shapes are:

- `triage`: `{ disposition, recordedAt } | null`.
- `inspection`: `{ result, inspectedAt } | null`.
- `diagnosis`: `{ scopeClassification, diagnosedAt } | null`. Diagnosis text and discipline/personnel IDs are omitted.
- `quotation`: `{ versions: [{ versionNumber, status, updatedAt }] } | null`. Lines, amounts, currency, decision notes, and actor IDs are omitted.
- `execution`: `null` without an execution-scope link; otherwise:
  - `scopeVariations`: `{ status, variationType, tenantDecisionOutcome, updatedAt }[]` only.
  - `dispatchRelease`: `{ status, releasedAt } | null` from the existing active-release reader.
  - `workSessions`: `{ status }[]` only.
  - `qualityControlRuns`: `{ status, updatedAt }[]` only.
  - `bast`: `{ status, issuedAt, acceptedAt, rejectedAt, voidedAt } | null`.
  - `paymentStatuses`: persisted payment status values (`PENDING`, `CONFIRMED`, `REJECTED`) or `null` when the existing reader has no ledger transaction. An empty array means a ledger transaction was found but no payment rows were returned.
  - `warranty`: `{ status, claimStatus, reworkStatus, chargeableAdditionalWorkStatus } | null` from the existing warranty read contract.

Statuses and timestamps are read from existing records; discovery does not infer or advance them. A returned Tenant decision outcome is a previously persisted fact, not an action or authority granted to Customer Care.

## 4. Known read gaps and interpretation

- The reused dispatch reader returns only active `RELEASED` / `IN_PROGRESS` releases. A `null` `dispatchRelease` does **not** prove that a dispatch never existed or that it completed/cancelled; historical dispatch states are not projected here.
- Work-session detail, events, personnel/helper identity, check-in/out times, and duration totals are deliberately omitted. Only the recorded session statuses are exposed.
- QC item/evidence/defect detail and BAST sign-off identities/signature digests are not exposed.
- Quotation and variation commercial values, internal notes, technical descriptions, audit events, provider fields, payment amounts, and private financial data are not exposed.
- A `null` payment or warranty projection reflects the existing reader's not-found result; it is not a synthetic payment verification or warranty status.
- Work Order lifecycle status is not projected; no Care-safe Work Order read is introduced here. Existing read surfaces can be extended later under their owning authorities. This route does not fabricate missing history or status.

## 5. Errors

Errors use the Backend envelope, for example:

```json
{
  "success": false,
  "error": {
    "code": "HANDYMAN_CARE_AUTHORITY_DENIED",
    "message": "Building Customer Care authority is not available for this building.",
    "category": "FORBIDDEN",
    "retryable": false
  }
}
```

Common outcomes:

| HTTP | Code | Meaning |
|---|---|---|
| `401` | `AUTHENTICATION_REQUIRED`, `INVALID_SESSION`, or `SESSION_EXPIRED` | Missing, invalid, expired, or non-Backend session. |
| `403` | `PERMISSION_DENIED` | Authenticated Backend user lacks `handyman.care.building`. |
| `403` | `HANDYMAN_CARE_AUTHORITY_DENIED` | User is not ACTIVE/assigned to this exact active Building, or its active Client/Property lineage cannot be established. This denial is non-enumerating. |
| `404` | `HANDYMAN_SERVICE_REQUEST_NOT_FOUND` | Request is absent or not owned by the selected Building/derived Client. |
| `400` | `VALIDATION_ERROR` | Invalid UUID, filter, pagination, unsupported query parameter, or non-empty GET body. |

An `hcw_`/BM workspace token is not a Backend session and is rejected by the existing Backend session middleware.

## 6. Stage boundaries and existing routes

- Existing BM-hosted Care workspace routes and their separate BM principal checks remain unchanged; this discovery API does not bypass or replace them.
- Existing `GET`/`POST /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/communications` remains a separate non-executable intake. New discovery routes do not change its `PENDING_VERIFICATION` state or add verification authority.
- Authority B remains blocked: this contract adds no Care quotation/variation/BAST decision route and does not permit automatic approval.
- No Tenant impersonation, payment verification, Work Order close, BM SSO exchange, migration, deployment, or production change is part of this delivery.
