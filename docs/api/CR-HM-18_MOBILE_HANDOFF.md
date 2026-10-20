# CR-HM-18 — Mobile API Handoff

**Audience**: the Mobile (worker app) Arena session — Crew Lead, inspector and
field crew clients.
**Backend repository**: `budiirmawan/Handyman-Backend`
**Version**: CR-HM-18 (branch `arena/69511628-handyman-backend`, base `d60e179`)
**API base**: `/api/v1` · envelope `{ "success": true, "data": ... }` /
`{ "success": false, "error": { code, message, category, requestId } }`

Companion documents: [`CR-HM-18_FULL_CAPABILITY_CLOSURE.md`](../handyman/CR-HM-18_FULL_CAPABILITY_CLOSURE.md),
[`CR-HM-18_FRONTEND_HANDOFF.md`](CR-HM-18_FRONTEND_HANDOFF.md),
[`CR-HM-18_OPERATIONS_HANDOFF.md`](CR-HM-18_OPERATIONS_HANDOFF.md).

---

## 1. Headline: no mobile work is required for CR-HM-18

CR-HM-18 adds two **staff/Care/Finance** capabilities:

1. cancelling a service request **before commercial commitment** (J01);
2. adjudicating a settlement dispute (J12).

Both are pre-execution or post-execution authorities. The worker app is
unaffected by construction:

| New capability | Why mobile cannot see it |
|---|---|
| Request cancellation | worker/job reads only expose execution scopes in `AUTHORIZED`; a cancelled request never has one (cancellation is refused once a scope exists) |
| Dispute adjudication | settlement is a Finance authority; no mobile route exposes settlement units, disputes or adjudications |

**No new mobile endpoint, permission, payload field or status value is
introduced by this CR.** The mobile contract is byte-compatible with the
previous release.

---

## 2. One defensive requirement (cheap, recommended)

Request-level reads carry a `requestStatus` field. It cannot currently become
`CANCELLED` on a job the worker can see, but the vocabulary has grown, so:

- treat unknown / new status values as **non-actionable** rather than crashing
  or falling back to “in progress”;
- never derive a job's actionability from `requestStatus`; use the scope status
  (`AUTHORIZED`), dispatch status (`RELEASED` / `IN_PROGRESS`) and the existing
  `availableActions` projections, which are the authority for every worker
  action.

**Do not** add a “cancel job” button. Workers cannot cancel requests or scopes
and the backend will refuse.

---

## 3. Worker contract that remains authoritative (unchanged)

### 3.1 Job visibility & feed

| Purpose | Operation |
|---|---|
| My jobs (flat feed) | `GET /handyman/field/my-jobs` |
| Work order detail | `GET /handyman/field/work-orders/{executionScopeId}` |
| Scope detail (alias) | `GET /handyman/field/execution-scopes/{executionScopeId}` |
| Materials on scope | `GET /handyman/field/execution-scopes/{executionScopeId}/materials` |
| Quotation snapshot | `GET /handyman/field/execution-scopes/{executionScopeId}/quotation-snapshot` |

Eligibility to appear in the feed (all must hold, enforced server-side):
scope `AUTHORIZED` · ACTIVE assignment · dispatch `RELEASED`/`IN_PROGRESS` ·
active crew membership for the session user · ACTIVE workforce profile and user ·
ACTIVE building · the user holds an ACTIVE building assignment.

### 3.2 Work session (check-in → check-out)

`POST /handyman/execution-scopes/{id}/work-sessions` (check-in) ·
`GET /handyman/execution-scopes/{id}/work-sessions/active` ·
`POST /handyman/work-sessions/{sessionId}/start|pause|resume|complete|material-run|check-out` ·
`GET /handyman/work-sessions/{sessionId}/time-projection`

### 3.3 Field lane (mobile forms)

| Purpose | Operation |
|---|---|
| Mobile sync (idempotent upload) | `POST /mobile/sync` |
| Assignments / my team | `GET /mobile/assignments`, `GET /mobile/my-team` |
| Current shift | `GET /mobile/current-shift` |
| Checklists | `/mobile/checklists[...]`, `/mobile/form-instances[...]` |
| Diagnostics | `/mobile/diagnostics[...]` |
| Permit-to-work | `/mobile/permit-work[...]` |
| Material requests | `/mobile/material-requests[...]` |
| Unsafe conditions | `/mobile/unsafe-conditions[...]` |
| Verification | `/mobile/verification[...]` |
| QR resolution | `POST /mobile/qr/resolve` |
| Operational state | `GET /mobile/operational-state` |

### 3.4 Execution-lane writes used by the app

- field evidence: `POST/GET /handyman/execution-scopes/{id}/evidence`, file
  upload/finalize;
- material: estimate → approve → issue → purchase → use → return → settle,
  plus `GET .../materials/final-charge-ready`;
- QC: `POST/GET .../qc-runs`, `.../qc-runs/items`, `.../qc-runs/evidence`,
  `.../qc-runs/finish`; defects `start-rectification` /
  `record-rectification` / `request-reinspection` / `pass-reinspection`;
- BAST (worker lane): prepare, issue, void — `POST/GET .../bast`,
  `POST .../bast/{bastId}/prepare|issue|void`;
- variations: `POST/GET .../variations` and the QC /
  `authorize-scope` / `final-charge-eligibility` steps;
- warranty rework: `POST .../service-warranty-reworks/{reworkId}/start|complete`.

### 3.5 Push

`CR_BE_PUSH_01` device registration/subscription routes are unchanged; the new
`HANDYMAN_REQUEST_CANCELLED` notification is a tenant/operations audience, not
a worker push — if a worker device happens to be subscribed to the whole client
stream, the payload still carries no worker action.

---

## 4. Error handling (unchanged codes the app already knows)

| HTTP | Code | App behaviour |
|---|---|---|
| `401` | `UNAUTHENTICATED` | re-auth |
| `403` | `PERMISSION_DENIED` | hide the action, do not retry |
| `404` | `NOT_FOUND` (`HANDYMAN_EXECUTION_SCOPE_NOT_FOUND`) | job revoked / not yours — drop from cache |
| `409` | `HANDYMAN_EXECUTION_CONFLICT` / state conflicts | refresh the scope, surface “state changed” |
| `422`/`400` | `VALIDATION_ERROR` | field-level message, no blind retry |

New CR-HM-18 codes (`HANDYMAN_SERVICE_REQUEST_CANCEL_*`,
`HANDYMAN_SETTLEMENT_*`) are **not reachable** from a worker token; treat them
as generic 4xx if ever observed and log the `requestId`.

---

## 5. Offline / sync notes

- `POST /mobile/sync` is the only sync entry point and echoes operation
  identifiers for idempotency; it does **not** resolve conflicting edits
  server-side (unchanged by this CR).
- Cancellation and adjudication are **online-only authorities**; nothing about
  them should be queued offline by the app.
- A job that disappears between syncs must be dropped from the local cache
  without a user-facing error (the feed is authoritative).

---

## 6. Mobile verification checklist

- [ ] Unknown `requestStatus` values render as neutral (no crash, no action).
- [ ] Job actionability still derived from scope + dispatch + `availableActions`.
- [ ] No cancel/adjudicate affordance added anywhere in the worker app.
- [ ] Feed refresh after a server-side state change drops stale jobs silently.
- [ ] Existing work-session, material, QC, BAST and warranty flows unaffected
      (no contract change).
