# CR-HM-18 — Frontend API Handoff

**Audience**: the Frontend (web) Arena session — Customer Care console, Handyman
Operations console, Finance workspace, Manager/Building-Management views.
**Backend repository**: `budiirmawan/Handyman-Backend`
**API base**: `/api/v1` · standard envelope `{ "success": true, "data": ... }` /
`{ "success": false, "error": { code, message, category, requestId } }`
**Version**: CR-HM-18 (branch `arena/69511628-handyman-backend`, base `d60e179`)

Read this together with
[`docs/handyman/CR-HM-18_FULL_CAPABILITY_CLOSURE.md`](../handyman/CR-HM-18_FULL_CAPABILITY_CLOSURE.md)
(authority rationale and evidence).

---

## 1. What changed for the Frontend

Three new capabilities (four operations), one new request status, three new
error codes. Nothing else in the contract was renamed or removed.

| # | Operation | Method / path | Permission | Screen |
|---|---|---|---|---|
| 1 | Cancel request | `POST /handyman/requests/{handymanRequestId}/cancel` | `tenant_company.manage` | Request detail (Operations / Customer Care) |
| 2 | Read cancellation | `GET /handyman/requests/{handymanRequestId}/cancellation` | `tenant_company.read` | Request detail — cancellation banner |
| 3 | Care cancel | `POST /handyman/care/buildings/{buildingId}/requests/{requestId}/cancel` | `handyman.care.building` | Customer Care building workspace |
| 4 | Adjudicate dispute | `POST /handyman/execution-scopes/{executionScopeId}/settlement/dispute/resolution` | `handyman.settlement.manage` | Finance / Settlement detail |

**New status**: `CANCELLED` on `handyman_service_requests` (terminal, alongside
`REFERRED`). Update every status chip, filter and empty-state copy.

---

## 2. Cancellation

### 2.1 Request bodies

```jsonc
// POST .../cancel  (both staff and Care routes)
{
  "reason": "Tenant withdrew the request.",   // 1..500 chars, required
  "idempotencyKey": "ui-3f2a…"                // 1..200 chars, required, single use
}
```

Nothing else is accepted. Send **no** actor, status, previous status, client or
building field:

- the **staff** route ignores unknown keys structurally (they never reach the
  service);
- the **Care** route rejects unknown keys and actor-identity spellings with
  `400`.

Generate one `idempotencyKey` per user intent (not per retry) and reuse it when
the same request is retried (network retry, double click).

### 2.2 Response (`200`)

```jsonc
{
  "success": true,
  "data": {
    "id": "c1f0…",                          // cancellation fact id
    "clientId": "…",
    "handymanRequestId": "…",
    "channelAttributionId": "…",
    "buildingId": "…",
    "previousStatus": "INTAKE",             // or TRIAGE | INSPECTION_REQUIRED | DIAGNOSIS | READY_FOR_NEXT_STEP
    "reason": "Tenant withdrew the request.",
    "cancelledByUserId": "…",               // always the session user
    "idempotencyKey": "ui-3f2a…",
    "occurredAt": "2026-10-20T12:00:00.000Z",
    "requestStatus": "CANCELLED",
    "replayed": false                        // true when the key was replayed
  }
}
```

Replay handling: `replayed: true` and the same `id` means “already done”. Treat
it as success and do **not** show an error toast.

### 2.3 When the button must be available

Show **Cancel request** only when the request is in one of:

`INTAKE`, `TRIAGE`, `INSPECTION_REQUIRED`, `DIAGNOSIS`, `READY_FOR_NEXT_STEP`.

Hide it for `REFERRED` and `CANCELLED`. Also hide it when the request already
has an approved quotation / execution scope; the backend is authoritative and
will refuse anyway (see §2.4) but the UI should not offer an impossible action.

> Suggested UI: a “Cancelled” banner on the request detail fed by
> `GET .../cancellation` (404 → not cancelled), showing `reason`, `occurredAt`
> and the cancelling user.

### 2.4 Errors

| HTTP | Code | UI treatment |
|---|---|---|
| `400` | `VALIDATION_ERROR` | inline validation (reason length, missing key, unknown field on the Care route) |
| `403` | `PERMISSION_DENIED` / `BUILDING_ACCESS_DENIED` / `HANDYMAN_CARE_AUTHORITY_DENIED` | “You do not have access to this building” |
| `404` | `HANDYMAN_SERVICE_REQUEST_NOT_FOUND` | request unknown or outside scope — do not enumerate |
| `409` | `HANDYMAN_SERVICE_REQUEST_CANCEL_NOT_ALLOWED` | terminal referral — explain the request is already closed as referred |
| `409` | `HANDYMAN_SERVICE_REQUEST_ALREADY_CANCELLED` | refresh and show the cancellation banner |
| `409` | `HANDYMAN_SERVICE_REQUEST_CANCELLATION_KEY_CONFLICT` | the key belongs to another cancellation — mint a fresh key; never retry blindly |
| `409` | `HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED` | explain: a quotation is approved; the work must be ended through the execution-scope lifecycle (do **not** offer a second cancel) |

---

## 3. Settlement dispute adjudication

### 3.1 Contract

```jsonc
// POST /handyman/execution-scopes/{executionScopeId}/settlement/dispute/resolution
{
  "exceptionId": "8b0d…",                    // existing DISPUTED settlement exception
  "outcome": "RELEASED",                     // RELEASED | UPHELD
  "note": "Evidence reviewed; hold cleared.",// 1..500 chars
  "idempotencyKey": "ui-settle-88c1…"
}
```

**Strict allow-list.** Sending `amount`, `currency`, `unitId`, `status`,
`actorUserId` or any other key is `400`.

Response:

```jsonc
{
  "success": true,
  "data": {
    "id": "…",
    "exceptionId": "8b0d…",
    "outcome": "RELEASED",
    "note": "Evidence reviewed; hold cleared.",
    "occurredAt": "2026-10-20T12:00:00.000Z",
    "replayed": false
  }
}
```

| Outcome | Meaning for the UI |
|---|---|
| `RELEASED` | the hold no longer blocks include/reconcile/settle or Manager final close |
| `UPHELD` | the hold stands; the unit stays blocked until a ledger correction is posted |

### 3.2 Eligibility rules to encode

- one adjudication per dispute — after a decision the action is disabled and
  the recorded outcome shown;
- no adjudication on a `SETTLED` settlement unit;
- requires `handyman.settlement.manage` (never implied by
  `tenant_company.manage`, `handyman.finance.manage` or
  `handyman.commercial.manage` — see the `0448` domain split).

### 3.3 Errors

| HTTP | Code | UI treatment |
|---|---|---|
| `400` | `VALIDATION_ERROR` | outcome vocabulary / note / key / unknown field |
| `403` | `PERMISSION_DENIED` | missing `handyman.settlement.manage` |
| `404` | `HANDYMAN_SETTLEMENT_NOT_FOUND` | dispute/exception not on this scope |
| `409` | `HANDYMAN_SETTLEMENT_CONFLICT` | already adjudicated, not a DISPUTED exception, or unit already `SETTLED` |
| `409` | `HANDYMAN_SETTLEMENT_INVALID` | malformed reference |

---

## 4. Surfaces the Frontend already relies on (unchanged, listed for wiring)

These are live, tested in this repository, and require no backend change —
listed so the session can wire them without re-auditing.

### 4.1 Request → quotation → approval

| Capability | Operation |
|---|---|
| Request list / detail | `GET /handyman/requests`, `GET /handyman/requests/:id` |
| Triage | `POST/GET /handyman/requests/:id/triage` |
| Inspection / diagnosis | `POST/GET /handyman/requests/:id/inspection`, `…/diagnosis` |
| Referral | `POST/GET /handyman/requests/:id/referral` |
| Quotation | `POST/GET /handyman/requests/:id/quotation`, `GET …/quotation/presented`, `POST /handyman/quotations/:id/versions`, `…/issue|/decision|/expire|/supersede` |
| Operations queue / commercial inbox | `GET /handyman/operations/queue`, `GET /handyman/operations/commercial-inbox` |
| Visits + tenant slot consent | `GET/POST /handyman/requests/:id/visits`, `…/:appointmentId/cancel-proposal`, `…/:appointmentId/confirm`, `GET /handyman/integrations/tenant-slot-choices` |
| Inspector assignment | `GET …/inspector/eligible`, `POST …/inspector`, `…/reassign`, `…/revoke`, `GET …/inspector-assignments/history` |

### 4.2 Execution → QC → BAST

| Capability | Operation |
|---|---|
| Crew assignment | `POST/GET /handyman/execution-scopes/:id/assignment`, `POST …/assignment/reassign` |
| Dispatch | `GET …/dispatch/readiness` (ordered gate failures), `POST …/dispatch/release`, `POST …/dispatch/cancel` |
| Arrival (J04) | `POST …/arrival-verification` (challenge token + opaque QR + optional device location → `PASS` / `MANUAL_REVIEW_REQUIRED` / `FAILED` + reason), `GET …/arrival-verification` |
| Assignment read | `GET …/assignment` returns the CURRENT crew + live Lead identity (`leadWorkerContextId`, `leadUserId`); it carries no snapshot, so a Lead change is reflected on the next read |
| Work sessions | `GET …/work-sessions/active`, `GET /handyman/work-sessions/:id/time-projection` |
| Material | `POST …/materials/estimate`, `…/:lineId/approve|issue|purchase|use|return|settle`, `GET …/materials/final-charge-ready` |
| Variations | `POST/GET …/variations`, `…/:variationId/tenant-decision|operations-review|qc|authorize-scope|final-charge-eligibility` |
| QC | `POST/GET …/evidence`, `…/qc-runs`, `…/qc-runs/items`, `…/qc-runs/evidence`, `…/qc-runs/finish`, defects `start-rectification|record-rectification|request-reinspection|pass-reinspection` |
| BAST (read + customer lane) | `GET …/bast`, `GET /handyman/bast/:bastId`, `POST /handyman/bast/:bastId/accept|reject|sign-off` |

### 4.3 Finance → settlement → close

| Capability | Operation |
|---|---|
| Ledger | `GET …/customer-ledger`, `GET /handyman/customer-ledger`, `POST …/customer-payments`, `…/:paymentId/confirm|reject` |
| Finance-close commands | `POST …/customer-transaction`, `…/customer-charge-lines`, `…/payment-allocations`, `…/ledger-refunds`, `…/ledger-reversals/allocation|payment`, `…/ledger-adjustments` |
| Invoice reconciliation | `GET …/invoice-reconciliation` (DP deducted once, variations, history) |
| Entitlements + settlement | `POST …/financial-entitlements/derive`, `POST …/settlement/prepare|include|reconcile|settle|correction|dispute` |
| Manager close | `GET …/final-close/readiness` (blocker list), `POST …/final-close` |
| Financial reads | `GET …/financial-transaction`, `GET /handyman/financial-transactions`, `GET /handyman/finance/action-inbox` |
| Commercial / BM fee | `POST /handyman/commercial-agreements`, `POST …/commercial-agreement-versions/:id/activate|supersede|labor-pricing-basis|material-pricing-basis|bm-fee-rule|bm-fee-term|bm-fee-beneficiary`, `GET /handyman/pricing-contract`, `GET /handyman/bm-fee-configuration` |

### 4.4 Warranty

`POST …/service-warranty/start`, `POST /handyman/service-warranties/:id/expire`,
claims `POST/GET /handyman/service-warranties/:id/claims`,
`POST /handyman/service-warranty-claims/:claimId/submit|approve|reject|withdraw`,
rework ladder `POST /handyman/service-warranty-reworks/:reworkId/authorize`
(customer lane), chargeable additional works
`POST /handyman/chargeable-additional-works/:workId/accept|reject`.

---

## 5. UI conventions the backend expects

1. **No client-side business authority.** Never compute amounts, statuses or
   actor identity; send references + `idempotencyKey` only.
2. **`availableActions`** projections exist for BAST, payments, warranty claims,
   reworks and chargeable works — render from them instead of re-deriving rules.
   Request cancellation availability is not (yet) part of a projection: use
   §2.3 rules and let the backend refuse.
3. **Money is a canonical decimal string** (`"100.00"`), never a float.
4. **Never retry a 409 automatically.** Only retry replays of the same
   idempotency key.
5. **404 vs 403**: both are non-enumerating denials; do not attempt to
   distinguish “missing” from “foreign building” in the UI copy.
6. **`Cache-Control: no-store`** is set on the Care routes; do not cache them.
7. **Reassignment is versioned**: send `{providerContextId, crewId, expectedVersion, reason, idempotencyKey}`. Read the current version from the assignment GET/assignment response; a stale version returns `409` and a same-crew call is a no-op (no history row).

---

## 6. What is NOT available (do not build)

- No post-commitment “cancel with fee” — use final close / variations.
- No appeal/second-level dispute adjudication.
- No provider payout execution (settlement records state only).
- No automatic cancellation notification template — backend emits the event,
  Operations must configure the template/subscription.

---

## 7. Verification checklist for the Frontend session

- [ ] `CANCELLED` rendered everywhere a request status appears (list, detail,
      filters, progress).
- [ ] Cancel dialog collects a reason (1–500) and reuses one idempotency key on
      retry; `replayed: true` treated as success.
- [ ] Cancel hidden for `REFERRED`, `CANCELLED`, and committed requests;
      `HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED` shows the explanatory message.
- [ ] Care workspace cancel uses the Care route (its permission is
      `handyman.care.building`, **not** `tenant_company.manage`).
- [ ] Dispute resolution form offers only `RELEASED` / `UPHELD`, requires a
      note, is hidden after a decision and on a `SETTLED` unit.
- [ ] Finance screens gate on `handyman.finance.read` / `handyman.finance.manage`
      / `handyman.settlement.manage` separately (no role implies another).
