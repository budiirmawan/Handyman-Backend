# CR-HM-BAST-HTTP-01 — Authorized Worker BAST Transport: Handyman-Operations handoff

Backend branch `arena/322959f2-handyman-backend`, based on main `4a36cb8` (PR #27 baseline). All paths are relative to `API_PREFIX` (normally `/api/v1`). Authentication (`Authorization: Bearer <session>`) is required on every route. HTTP success uses the existing `{ success, data, meta }` envelope; failures use the existing error envelope (`{ success: false, error: { code, message, details?, category, retryable, requestId } }`). This CR adds **only** the worker PREPARE/ISSUE/VOID transport over the existing frozen CR-HM-11 engine — no new BAST engine, no customer approval, no financial write.

## Endpoints (worker lane, `handyman-bast-worker-api`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/handyman/field/execution-scopes/:executionScopeId/bast/prepare` | Create the DRAFT BAST anchored to the latest guarded Supervisor QC PASS (201; 200 on idempotent replay) |
| POST | `/handyman/field/bast/:bastId/issue` | DRAFT → ISSUED (200) |
| POST | `/handyman/field/bast/:bastId/void` | DRAFT\|ISSUED → VOID with required reason (200) |

There is **no** worker accept/reject/sign-off route and **no** other worker BAST mutation. `POST /handyman/bast/:bastId/accept|reject|sign-off` remain the customer lane (below). Invented URLs (`/handyman/bast/:id/prepare|issue|void`, `/handyman/execution-scopes/:id/bast/prepare`) stay 404.

## Authority (all four layers, never a persona name or generic login)

1. **Authenticated local session.** The actor is always `req.auth.userId`; no request field may name an actor, client, building, crew or provider (unknown body fields are ignored, never forwarded).
2. **`handyman.bast.manage`** — new dedicated capability (migration `0446`), registered ACTIVE but granted to **no** role by migration or foundation seed (withheld like `handyman.qc.manage`). Enabling the worker lane is a deliberate administrative grant. Provision it explicitly (role → permission), e.g. to the field Crew Lead role(s).
3. **Exact BE-02G Building access** — the actor needs an ACTIVE `user_building_assignment` to the execution scope's authoritative server-derived Building (no same-Client sibling shortcut). Enforced both at transport preamble and inside the service transaction.
4. **CURRENT authoritative Crew Lead binding** — `resolveHandymanAssignmentLead` (scope → ACTIVE assignment → crew → current CR-HM-04 Lead). This is the Provider/Operations assignment: a reassignment moves the lane to the new Lead; an Operations title, admin role or frontend label cannot stand in for it. Failure is 403 `HANDYMAN_BAST_NOT_AUTHORIZED`.

All four are AND-ed: the permission alone authorizes nothing; the lead binding alone authorizes nothing.

## Payloads

All requests are JSON. `idempotencyKey` (1..200 chars) is required everywhere; the same key replayed on the same command returns the **original** event with `replayed: true` (safe retries).

**prepare** — `{ "idempotencyKey": "..." }` (an optional `expectedVersion` is ignored on this route: there is no prior document).

**issue** — `{ "idempotencyKey": "...", "expectedVersion": 1 }` (`expectedVersion` optional).

**void** — `{ "idempotencyKey": "...", "reason": "Customer postponed handover", "expectedVersion": 2 }` (`reason` **required**, 1..2000 chars; `expectedVersion` optional).

`expectedVersion` is the `artifact.version` the client last observed (below). Mismatch while the document is still in a legal from-state → 409 `HANDYMAN_BAST_VERSION_CONFLICT` before any mutation. The check is skipped for an idempotent replay, so retries with a stale `expectedVersion` still succeed.

**Command response (`data`)** — same shape for all three commands:

```jsonc
{
  "bast": {
    "id": "…", "executionScopeId": "…", "qcRunId": "…",   // qcRunId null only for pre-0445 history
    "status": "DRAFT | ISSUED | ACCEPTED | REJECTED | VOID",
    "issuedAt": …, "acceptedAt": …, "rejectedAt": …, "voidedAt": …,
    "createdAt": …, "updatedAt": …,
    "artifact": { "ref": "BAST/<id>/v1", "version": 1 },   // server-owned; never forge
    "availableActions": ["ISSUE", "VOID"]                   // worker lane, derived from the frozen lifecycle
  },
  "acceptance": {
    "bastId": "…", "executionScopeId": "…", "status": "…",
    "customerAccepted": false,        // false until the customer ACCEPT sign-off
    "warrantyStartEligible": false,   // true only for ACCEPTED
    "issuedAt": …, "acceptedAt": …, "rejectedAt": …, "voidedAt": …,
    "artifactRef": "BAST/<id>/v1"
  },
  "event": {
    "id": "…", "bastId": "…", "executionScopeId": "…",
    "eventType": "PREPARE | ISSUE | VOID",
    "idempotencyKey": "…", "actorUserId": "…",
    "occurredAt": …, "createdAt": …,
    "voidReason": null                // the preserved reason on VOID events
  },
  "replayed": false
}
```

Artifact versions (deterministic, status-derived): DRAFT → 1, ISSUED → 2, ACCEPTED/REJECTED → 3, VOID → 2. `availableActions`: DRAFT → `[ISSUE, VOID]`, ISSUED → `[VOID]`, otherwise `[]`.

## Lifecycle (frozen CR-HM-11 state machine — unchanged)

```
PREPARE → DRAFT (anchored to the latest guarded Supervisor QC PASS)
ISSUE   : DRAFT   → ISSUED    (never customer acceptance)
VOID    : DRAFT|ISSUED → VOID (reason preserved; history never deleted)
ACCEPT  : ISSUED  → ACCEPTED  (customer lane only)
REJECT  : ISSUED  → REJECTED  (customer lane only)
```

- PREPARE requires the latest **guarded** Supervisor QC PASS (versioned checklist manifest + guarded FINISH + all required items PASS + all Work Sessions completed/checked out + zero unverified defects + byte-verified `QC_EVIDENCE` upload re-hashed from storage) and re-anchors it as immutable `bast.qcRunId`. One active (non-VOID) BAST per execution scope.
- ISSUE rechecks that the anchored run is **still** the latest valid PASS. If a new QC run opens, ISSUE fails with 409 `HANDYMAN_BAST_QC_NOT_READY`; VOID remains possible.
- VOID preserves the document, the full append-only event chain and any prior acceptance evidence. Concurrent duplicate commands serialize to exactly one legitimate transition (atomic state precondition); the loser gets 409 `HANDYMAN_BAST_ILLEGAL_TRANSITION`.
- QC PASS, BAST ISSUE, BAST ACCEPTED, invoice PAID and Manager CLOSE remain different states. Nothing on the worker lane changes acceptance, invoice, payment, settlement, warranty or close state.

## Error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Malformed UUID/idempotencyKey/expectedVersion/reason (details name the field) |
| 401 | `AUTHENTICATION_REQUIRED` | Missing/invalid session |
| 403 | `PERMISSION_DENIED` | `handyman.bast.manage` not granted (also what a Crew Lead without the grant gets) |
| 403 | `BUILDING_ACCESS_DENIED` | No ACTIVE assignment to the scope's exact Building (also cross-Building attempts) |
| 403 | `HANDYMAN_BAST_NOT_AUTHORIZED` | Not the CURRENT Crew Lead of the execution scope's active assignment |
| 404 | `HANDYMAN_EXECUTION_SCOPE_NOT_FOUND` / `HANDYMAN_BAST_NOT_FOUND` | Unknown scope/document |
| 409 | `HANDYMAN_BAST_QC_NOT_READY` | Missing/latest-invalid guarded QC PASS, open defects, incomplete sessions, or unverified/stale QC bytes |
| 409 | `HANDYMAN_BAST_ACTIVE_CONFLICT` | An active (non-VOID) BAST already exists for the scope (different idempotencyKey) |
| 409 | `HANDYMAN_BAST_ILLEGAL_TRANSITION` | Not a legal transition from the current status (includes lost concurrency races) |
| 409 | `HANDYMAN_BAST_VERSION_CONFLICT` | `expectedVersion` mismatch against the artifact version |

## Document / evidence access

- BAST reads stay on the Customer Care transport: `GET /handyman/execution-scopes/:executionScopeId/bast` and `GET /handyman/bast/:bastId` (`tenant_company.read` + exact Building). They return the document, the acceptance contract, the full event chain (including the preserved `voidReason`, null on other events) and sign-off rows; command responses above are also immediately consistent (read-after-write).
- QC evidence bytes remain under the existing field-evidence contract (`POST /handyman/field/execution-scopes/:executionScopeId/evidence/upload` → `hm-ev://<uuid>` references). The BAST artifact reference `BAST/<id>/v<N>` is server-computed metadata for UI tracking — it is not a storage key and must never be generated client-side.

## Existing Customer ACCEPT/REJECT contract (unchanged)

- `POST /handyman/bast/:bastId/accept` — `tenant_company.manage` + exact Building; legal only from ISSUED; requires `idempotencyKey` + `signatureDigest` (≤512 chars) + optional `evidenceRecordId`; rechecks the anchored QC PASS; records an ACCEPT sign-off row; status → ACCEPTED.
- `POST /handyman/bast/:bastId/reject` — same authority; optional `rejectReason` (≤2000)/`signatureDigest`/`evidenceRecordId`; status → REJECTED.
- `POST /handyman/bast/:bastId/sign-off` — combined `decision: "ACCEPT" | "REJECT"` wrapper. `PREPARE`/`ISSUE`/`VOID`/alias decisions are rejected 400.
- Only ACCEPTED (with signature evidence) implies `customerAccepted` / `warrantyStartEligible`. A Crew Lead with `handyman.bast.manage` still cannot accept — the customer lane requires `tenant_company.manage`.

## Expected Operations UI integration

1. **Worker app (field):** enable PREPARE/ISSUE/VOID buttons only when the command response `bast.availableActions` contains them. Send a fresh UUID `idempotencyKey` per user action and keep retrying with the **same** key on network failure (replay is safe). Track `bast.artifact.version` from reads and send it as `expectedVersion` on ISSUE/VOID for optimistic concurrency; on 409 `HANDYMAN_BAST_VERSION_CONFLICT`/`ILLEGAL_TRANSITION`, refetch (`GET /handyman/bast/:id`) and re-render rather than assuming success.
2. **VOID UX:** collect a non-empty reason (≤2000 chars) before enabling the action; it is permanently recorded as `event.voidReason`.
3. **QC gate UX:** 409 `HANDYMAN_BAST_QC_NOT_READY` is a data-state message (missing/invalid latest QC PASS or open defects) — link the user to the QC/defect screens instead of retrying.
4. **Provisioning:** grant `handyman.bast.manage` explicitly to the intended field role(s) after deploying this backend. Until then the endpoints answer 403 `PERMISSION_DENIED` by design. Do not grant it to Customer Care roles for this purpose — customer sign-off is a different lane.
5. **Customer Care screens:** keep using the existing reads + accept/reject/sign-off; the worker command responses can render the same acceptance contract to show that ISSUED ≠ ACCEPTED.

## Validation and delivery

- Commits (in order): P1 permission contract + VOID audit metadata (`0446`), P2 worker transport module + routes, P3 OpenAPI contract, P4 focused tests + atomic transitions, P5 handoff, P6 concurrent idempotency serialization + VOID reason read-after-write.
- Focused disposable embedded-PostgreSQL suite: **10/10 pass, 0 fail, 0 skipped** (`tests/handyman-bast-worker-api.test.ts`), covering authorized lifecycle/replays/read-after-write/historical preservation, same-Client sibling and cross-Client Building denial, 401/403 matrix with zero mutation, QC admission, concurrent different-key transitions and same-key PREPARE/ISSUE/VOID replay, `expectedVersion`, typed 400s, customer sign-off separation and finance/close guards. Regression: `tests/handyman-qc-supervisor-authority.test.ts` 23/23, BAST unit suites 32/32, `tests/config-perm-01-permission-registry.test.ts` 13/13. OpenAPI contract test 4/4; YAML, worker operation/schema and `$ref` validation clean; `npm run typecheck` passes.
- Known pre-existing test debt (identical on baseline `4a36cb8`, untouched by this CR): `tests/handyman-customer-care-qc-bast.test.ts` (fixture drift vs CR-HM-QC-AUTHORITY-01 supervisor/QC rules) and `tests/handyman-customer-care-transport-certification.test.ts` (pins historical git commits absent from shallow clones).
- No production migration, Railway deployment or PR merge was performed.
