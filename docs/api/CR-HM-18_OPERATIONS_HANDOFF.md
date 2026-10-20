# CR-HM-18 — Operations Handoff

**Audience**: Handyman Operations, Customer Care, Finance and Building-Manager
operations (people and the Operations Arena session that maintains runbooks).
**Backend repository**: `budiirmawan/Handyman-Backend`
**Version**: CR-HM-18 (branch `arena/69511628-handyman-backend`, base `d60e179`)
**Companion documents**: [`CR-HM-18_FULL_CAPABILITY_CLOSURE.md`](../handyman/CR-HM-18_FULL_CAPABILITY_CLOSURE.md)
(authority + evidence), [`CR-HM-18_FRONTEND_HANDOFF.md`](CR-HM-18_FRONTEND_HANDOFF.md)
(screens), [`CR-HM-18_MOBILE_HANDOFF.md`](CR-HM-18_MOBILE_HANDOFF.md) (worker app).

---

## 1. What the backend can now do that it could not before

| # | Capability | Operational meaning |
|---|---|---|
| 1 | **Request cancellation before commercial commitment** | Customer Care can close a request that will never be worked, with a recorded reason, without faking a referral or leaving it stuck in intake |
| 2 | **Settlement dispute adjudication** | A disputed settlement hold can now be decided (`RELEASED` or `UPHELD`) instead of blocking the unit, the settlement and Manager final close forever |
| 3 | **Evidence repair** | The finance-close and lifecycle HTTP suites now actually run (previously failing/skipped) — the reports you rely on are backed by live evidence |

Everything else in the 16-domain matrix was already complete and was verified,
not rebuilt.

---

## 2. Runbook — cancelling a request (J01)

**Who**: Operations / Customer Care staff with `tenant_company.manage` on the
request's building, or a Care officer with `handyman.care.building` and an
ACTIVE assignment to that building.

**Steps**

1. Open the request. Confirm it is in `INTAKE`, `TRIAGE`,
   `INSPECTION_REQUIRED`, `DIAGNOSIS` or `READY_FOR_NEXT_STEP`.
2. Confirm **no approved quotation / execution scope exists**. If one does, the
   request is committed — cancellation is refused by design; use the execution
   scope's close / variation / final-close path instead.
3. Enter a reason of 1–500 characters **that a customer could read**. It is
   stored verbatim and appears in the audit history.
4. Confirm. The request becomes `CANCELLED` (terminal) and the reason, actor,
   time and idempotency key are stored in an append-only record that cannot be
   edited or deleted — not even by an administrator or a migration.

**Do not**

- cancel a request that has an approved quotation: the work must be ended
  through the scope, otherwise money facts would outlive their subject;
- cancel a `REFERRED` request (already closed);
- re-cancel to “fix” a wrong reason — the record is immutable; open a
  corrective note in the ticket instead.

**Common responses**

| Situation | Backend answer | Action |
|---|---|---|
| Cancelled successfully (or retried) | `200`, `requestStatus: CANCELLED`, `replayed: true` on a retry | nothing further |
| Already cancelled with a different intent | `409 HANDYMAN_SERVICE_REQUEST_ALREADY_CANCELLED` | refresh; the original record stands |
| Retry reused a key from another cancellation | `409 HANDYMAN_SERVICE_REQUEST_CANCELLATION_KEY_CONFLICT` | generate a new key for this intent |
| Approved quotation exists | `409 HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED` | use the scope lifecycle |
| Request is `REFERRED` | `409 HANDYMAN_SERVICE_REQUEST_CANCEL_NOT_ALLOWED` | nothing to cancel |
| Not your building | `403` (Care: `HANDYMAN_CARE_AUTHORITY_DENIED`) | request access, do not retry |
| Bad reason / unknown field | `400` | fix the form input |

**Notification**: the backend emits `HANDYMAN_REQUEST_CANCELLED`. Delivery only
happens if Operations has configured the template `HANDYMAN_REQUEST_CANCELLED`
and a subscription rule for the audience (see §5).

---

## 3. Runbook — adjudicating a settlement dispute (J12)

**Who**: Finance / Settlement staff holding `handyman.settlement.manage`.
No other permission implies it (`tenant_company.manage`,
`handyman.finance.manage` and `handyman.commercial.manage` are all separate).

**Background.** A provider (or BM) disagreement is recorded as a `DISPUTED`
settlement exception. While it exists the settlement cannot include or settle
the unit and Manager final close reports `OPEN_SETTLEMENT_EXCEPTION`.

**Steps**

1. Open the settlement unit / execution scope.
2. Collect the evidence (work sessions, QC, BAST, ledger, invoice
   reconciliation).
3. Choose **one** outcome and record a note of 1–500 characters:
   - `RELEASED` — the hold is not justified. The unit becomes settleable again
     and Manager final close stops reporting the blocker.
   - `UPHELD` — the hold stands. The unit stays blocked until a **ledger
     correction** is posted through the existing correction command.
4. Submit once. One adjudication per dispute; the decision is append-only.

**Constraints**

- the decision cannot move money, create a charge, refund, reversal or
  adjustment — money only changes through the ledger commands;
- it cannot change the settlement unit's state, and it cannot be made on an
  already `SETTLED` unit;
- a second submission with the same idempotency key and same outcome returns
  the original decision (`replayed: true`); with a different intent it is
  rejected (`409`);
- `UPHELD` is **not** an escape hatch: the exception keeps blocking until the
  ledger is corrected.

**Escalation.** There is no second-level appeal in the backend. If a dispute
needs a commercial committee, record the committee's decision in the note and
have a single adjudicator submit it; disputes beyond that are a product
decision (see §6).

---

## 3A. Runbook — crew assignment, dispatch and arrival (J04, verified)

1. **Assign** a crew to an AUTHORIZED scope. Eligibility is enforced server-side: the crew Lead needs an ACTIVE user Building assignment, and **every** member needs an ACTIVE workforce Building placement plus a vendor workforce binding. A failure here is a staffing/registration problem, not a UI bug.
2. **Reassign** with `{expectedVersion, reason}`. A stale version is a `409` — re-read and retry. Reassigning to the same crew is a no-op and writes no history.
3. An **active work session blocks transfer** of the PIC; end the session first.
4. **Dispatch readiness** lists every unmet gate (permit, slot consent, access, assignment, certification). Release is refused until each is satisfied; concurrent duplicate releases are serialized to one.
5. **Arrival verification** is the Lead's own act: request a challenge, then verify with the opaque QR/device location. `MANUAL_REVIEW_REQUIRED` means the desk must decide (no policy or out-of-geofence); it is not a system failure. Reassignment supersedes an active release.

## 4. What Operations must configure (or the capability is silent)

| Item | Where | Required action |
|---|---|---|
| Template `HANDYMAN_REQUEST_CANCELLED` | notification templates | create the template + copy (tenant-facing and internal variants) |
| Subscription rule for the cancellation event | notification subscriptions | decide who receives it (tenant, PIC, Care desk, BM) |
| Settlement-dispute decision evidence | operational procedure | decide the artefact that must exist before `RELEASED` (this is a policy, not a system rule) |
| Cancellation reason taxonomy | operational procedure | optional: publish approved reason phrasings so reports aggregate cleanly (the backend stores free text) |
| Finance action-inbox triage | `GET /handyman/finance/action-inbox` | verify the `OPEN_EXCEPTION` blocker clears after `RELEASED` and persists after `UPHELD` |

> The backend does **not** auto-create notification templates. An event with no
> template is a no-op delivery, which is why the table above is a launch
> checklist item, not a nice-to-have.

---

## 5. Operational event / audit vocabulary

- Audit contract: **16** Handyman event types (was 15). New:
  `HANDYMAN_REQUEST_CANCELLED`.
- Notification contract: **13** events (was 12). New:
  `HANDYMAN_REQUEST_CANCELLED` (audience resolved through subscription rules,
  template key `HANDYMAN_REQUEST_CANCELLED`).
- Dispute adjudication is **state-recorded, not a notification event**: it is
  visible through the settlement/finance reads and the Manager final-close
  readiness payload. Do not expect an outbound message for it.

---

## 6. Explicitly not decided (do not promise these)

1. Cancelling **after** quotation approval (with or without a fee).
2. A second-level dispute appeal, adjudication SLA, or an automatic outcome on
   timeout.
3. Payout execution — settlement records state; disbursement stays outside the
   backend.
4. Automatic cancellation messaging without the template/subscription above.
5. Mobile offline conflict resolution beyond operation-id echo.

These are recorded as product/authority decisions in
`CR-HM-18_FULL_CAPABILITY_CLOSURE.md` §6.1.

---

## 7. Launch verification (Operations checklist)

- [ ] Care desk can cancel an `INTAKE` request and the tenant sees the recorded
      reason.
- [ ] Cancelling a committed (approved-quotation) request is refused and the
      desk knows the escalation path.
- [ ] Cancellation event appears in audit and in the notification stream once
      the template is configured.
- [ ] Finance can `RELEASE` a disputed hold and Manager final close stops
      reporting `OPEN_SETTLEMENT_EXCEPTION`.
- [ ] Finance can `UPHOLD` a disputed hold and the unit remains blocked;
      correcting the ledger is the only unblock.
- [ ] `handyman.settlement.manage` is granted to the correct (small) group —
      review the `0448` permission split before go-live.
- [ ] Reports reconcile: cancelled requests are excluded from active workload,
      and released disputes no longer appear in the finance action inbox.
