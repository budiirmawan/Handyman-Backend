# Authoritative Handyman Main Request close

This command closes the **whole Main Request**, not an execution scope. The authoritative closure state is the immutable, unique `handyman_request_close_events` record; the existing intake `handyman_service_requests.status` is retained and is not the closure projection. No old Request is inferred or backfilled as closed.

## Operations API

* `GET /api/v1/handyman/requests/{id}/close` returns `{ requestId, clientId, buildingId, status: "OPEN" | "CLOSED", event }`. `OPEN` means no Main Request close event exists, not that any execution or finance gate is satisfied. The event is `null` until closed.
* `POST /api/v1/handyman/requests/{id}/close` takes:

```json
{
  "reason": "All required work and settlement verified",
  "idempotencyKey": "unique-command-key",
  "expectedScopeSetRevision": "12",
  "expectedScopeSetFingerprint": "<lowercase SHA-256 from close-readiness>"
}
```

Read and review `GET /handyman/requests/{id}/close-readiness` first; copy **both** returned pins. The service rechecks all live readiness gates inside the close transaction, not just these scope pins. A stale scope pin gives `HANDYMAN_REQUEST_SCOPE_SET_CHANGED`; blocked live readiness gives `HANDYMAN_REQUEST_CLOSE_BLOCKED` with precise blockers. A new close returns 201. An exact retry by the same actor and same reason, key and pins returns the original event with `replayed: true` and 200, even if later Finance facts change. Any different close command after closure returns `HANDYMAN_REQUEST_ALREADY_CLOSED` (409). No query parameters or extra body fields are accepted. Responses are `private, no-store`.

Both endpoints require an active authenticated local session, explicit `tenant_company.manage`, `handyman.commercial.manage`, `handyman.finance.read`, and `handyman.customer_tax.read`, plus exact active Client/Building access and the existing Operations non-customer authority. POST additionally requires `finding.close`, the existing Manager close permission; an executing crew member or assigned inspector cannot perform this command. Permissions, session and assignment are held through commit.

## Atomicity and provenance

CLOSE locks existing ORIGINAL scopes, the Request and its exclusive scope-set revision fence, then the same ledgers, invoice-source fences and tax authority heads used by the live readiness evaluator. It requires READ COMMITTED, compares both reviewed scope pins and re-evaluates all operational, QC, accepted BAST, invoice, Finance, Payment Receipt, Final Receipt delivery and per-item warranty requirements. Unresolved approvals, ambiguous invoices, pending payments and unverified outbound refunds remain blockers. BM commission settlement is independent.

The single event records the actor and authenticated session, time, reason, exact Client/Building/Request, scope-set revision/fingerprint, the complete READY assessment and version/checksum references to the original approvals, completion, QC, BAST, official invoice, independently verified payments/allocations and receipts, acknowledged delivery, and warranty certificate or contractual `NOT_APPLICABLE`. A canonical SHA-256 and database checks protect the immutable source snapshot. It is an **as-of close** fact: later legitimate corrections do not rewrite it or silently reopen the Request; the live readiness endpoint can subsequently be BLOCKED.

Original quotation APPROVE, original scope creation, and original variation customer approval/Operations authorization are synchronized against the same exclusive fence. If an approval commits first, CLOSE sees the changed scope or blocks; if CLOSE commits first, the approval is rejected with `HANDYMAN_REQUEST_ALREADY_CLOSED`. Direct database approval paths are also guarded. READ COMMITTED is mandatory for guarded original approvals so a stale repeatable-read snapshot cannot miss the close event. Historical approval replay remains available; a new post-close commercial lifecycle is not implemented.

CLOSE does not change execution-scope, BAST, invoice, receipt, ledger, payment or warranty history, and does not expire warranty. Warranty claims and `WARRANTY_REWORK` remain separate; this original-commercial-approval fence does not prohibit the existing warranty-rework lifecycle. No legacy `tenant_invoices` are created or required.
