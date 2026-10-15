# CR-HM-BAST-WORKER-READ-01 — Handyman-Mobile PR #11 handoff

Backend PR #28 adds one worker-authorized, read-only BAST endpoint for Mobile refresh/read-after-command. It reuses the existing active-then-latest BAST selection and lifecycle services; it does not add a second lifecycle engine. All paths below include the normal `/api/v1` prefix.

## Exact request

```http
GET /api/v1/handyman/field/execution-scopes/{executionScopeId}/bast
Authorization: Bearer <session-token>
Accept: application/json
```

There is no request body. `executionScopeId` must be a UUID. Do not send or derive `clientId`, `buildingId`, crew, provider, or actor identity from Mobile; the backend resolves them from the execution scope and session.

## Authority and behavior

The request requires all of:

- an authenticated local session;
- the explicit `handyman.bast.manage` permission;
- ACTIVE Building access to the exact server-derived scope Building; and
- the actor to be the CURRENT authoritative Crew Lead on that execution-scope assignment.

A valid field worker does **not** need `tenant_company.read` for this endpoint. Customer Care keeps its separate full-read and `tenant_company.manage` sign-off routes. The worker GET is read-only: it cannot PREPARE, ISSUE, VOID, ACCEPT, REJECT, sign, create invoice/payment/warranty state, or close a request.

The BAST is selected using the existing service's policy: current active (non-VOID) document first, otherwise the latest historical document; no document yields `bast: null`. Event history in this projection is limited to that selected document's `PREPARE`, `ISSUE`, and `VOID` events. Customer Care `ACCEPT`/`REJECT` events, sign-off rows, signature digests, evidence IDs, `approvedSignOff`, and `signOffComplete` are not returned. Customer decision is exposed only as bounded status/eligibility facts (`customerAccepted`, `warrantyStartEligible`, and timestamps).

## Exact response shape

HTTP 200, using the standard `{ success, data, meta }` envelope. The following is a representative response after a DRAFT has been prepared; nullable timestamps are `null` until that lifecycle event occurs.

```json
{
  "success": true,
  "data": {
    "executionScopeId": "<execution-scope-uuid>",
    "scopeStatus": "AUTHORIZED",
    "bast": {
      "id": "<bast-uuid>",
      "executionScopeId": "<execution-scope-uuid>",
      "qcRunId": "<guarded-qc-run-uuid>",
      "status": "DRAFT",
      "issuedAt": null,
      "acceptedAt": null,
      "rejectedAt": null,
      "voidedAt": null,
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>",
      "artifact": {
        "ref": "BAST/<bast-uuid>/v1",
        "version": 1
      },
      "availableActions": ["ISSUE", "VOID"]
    },
    "acceptance": {
      "bastId": "<bast-uuid>",
      "executionScopeId": "<execution-scope-uuid>",
      "status": "DRAFT",
      "customerAccepted": false,
      "warrantyStartEligible": false,
      "issuedAt": null,
      "acceptedAt": null,
      "rejectedAt": null,
      "voidedAt": null,
      "artifactRef": "BAST/<bast-uuid>/v1"
    },
    "eligibility": {
      "currentWorkerAssignment": "CURRENT_CREW_LEAD",
      "scopeAuthorized": true,
      "bastQcRunId": "<guarded-qc-run-uuid>",
      "prepareRequiresLatestGuardedQcPass": true,
      "issueRequiresAnchoredQcPassToRemainLatest": true,
      "customerAccepted": false,
      "warrantyStartEligible": false
    },
    "lifecycleActions": ["ISSUE", "VOID"],
    "events": [
      {
        "id": "<event-uuid>",
        "bastId": "<bast-uuid>",
        "executionScopeId": "<execution-scope-uuid>",
        "eventType": "PREPARE",
        "idempotencyKey": "<original-command-key>",
        "actorUserId": "<worker-user-uuid>",
        "occurredAt": "<ISO-8601>",
        "createdAt": "<ISO-8601>",
        "voidReason": null
      }
    ]
  },
  "meta": {}
}
```

### Empty and other lifecycle states

- **No BAST yet:** `bast: null`, `acceptance: null`, `events: []`, and `lifecycleActions: ["PREPARE"]`. PREPARE still requires the latest guarded Supervisor QC PASS; the GET does not pre-authorize or mutate that command.
- **DRAFT:** `lifecycleActions: ["ISSUE", "VOID"]`; `bast.availableActions` is the same.
- **ISSUED:** `lifecycleActions: ["VOID"]`; customer acceptance remains false until Customer Care acts.
- **ACCEPTED / REJECTED:** `lifecycleActions: []`. If accepted, `customerAccepted` and `warrantyStartEligible` are true; the `ACCEPT` event and sign-off details remain hidden from this worker projection.
- **VOID:** `lifecycleActions: ["PREPARE"]`. The VOID reason is present only on the worker VOID event. If a new active BAST is later prepared, it is returned instead and the historical VOID record remains stored and unchanged.

`lifecycleActions` are worker-lifecycle candidates only. Command services remain authoritative and recheck QC, status, idempotency, and version. Use `bast.artifact.version` as `expectedVersion` on ISSUE/VOID: DRAFT is version 1, ISSUED is 2, ACCEPTED/REJECTED is 3, and VOID is 2. Keep the same idempotency key when retrying an uncertain POST.

## Refresh integration

1. Call this GET when opening the execution-scope BAST screen and after app resume/refresh.
2. After PREPARE, ISSUE, or VOID, use the command response for immediate feedback and this GET to reconcile after network uncertainty or a conflict. Do not infer a command result from a local optimistic update.
3. Render worker BAST actions from `data.lifecycleActions`; keep QC errors as server-authoritative gate results. Render acceptance only as a read-only state indicator. Never offer ACCEPT/REJECT/sign-off from this worker screen.
4. Do not call Customer Care BAST reads from the worker session as a fallback. Do not persist or display tenant/building data or any sign-off evidence from another endpoint in this field-worker projection.

## Expected errors

| HTTP | Error code | Mobile behavior |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid scope UUID; treat as a client bug/input problem. |
| 401 | `AUTHENTICATION_REQUIRED` | Refresh/re-authenticate the session. |
| 403 | `PERMISSION_DENIED` | Worker capability is not granted; do not retry as a generic user. |
| 403 | `BUILDING_ACCESS_DENIED` | Exact Building assignment is missing; show an access/support state. |
| 403 | `HANDYMAN_BAST_NOT_AUTHORIZED` | Actor is no longer the current Crew Lead; stop worker actions and refresh assignment context. |
| 404 | `HANDYMAN_EXECUTION_SCOPE_NOT_FOUND` | Scope is not available; do not fall back to an unscoped BAST read. |

This read route has no lifecycle-specific 409 because it does not mutate. See the worker command contract in [CR-HM-BAST-HTTP-01_OPERATIONS_HANDOFF.md](./CR-HM-BAST-HTTP-01_OPERATIONS_HANDOFF.md) for PREPARE/ISSUE/VOID request bodies and conflict handling.