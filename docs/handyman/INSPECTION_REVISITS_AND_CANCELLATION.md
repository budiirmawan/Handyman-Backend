# Operations pre-quotation cancellation and inspection revisits

## Authority and scope

Owner decisions received **2026-10-11** resolve the earlier
[authority blocker](NOT_INSPECTABLE_REVISIT_AUTHORITY_BLOCKER.md).
Implementation starts from `bbe8afcb7d47ed31badcf979e1e848198a7206d6` on
`arena/d04dc185-handyman-backend`. No new approval is required for these decisions.

- Operations may irreversibly cancel an open request **before any quotation**.
  The new terminal disposition is `CANCELLED_PRE_QUOTATION`, not `REFERRED` and
  not an FM cancellation or PIC decision. No reopening endpoint exists.
- A new `INTAKE` request may reference a cancelled predecessor in the same
  Client/Building. It inherits **no** triage, report, diagnosis, approval or scope.
- Each revisit has its own immutable planning fact, physical attempt number,
  and **new Field assignment**, even when the same person returns.
- A revisit pins an existing **preferred-window readiness version**, not a
  confirmed booking. It creates no post-PIC scheduling target or Execution Scope.
- Accepting a `NOT_INSPECTABLE` report acknowledges the unsuccessful account;
  it never authorizes diagnosis or quotation. A later `INSPECTED` attempt with
  an accepted latest report can unlock the existing guarded preparation path.

## API and permissions

All paths below are relative to `/api/v1/handyman/requests/:handymanRequestId`.
Authenticated actor and Client/Building context are server-derived. New write
permissions are enforced both at HTTP admission and in the service, including
active-user checks. No permission is automatically granted to any role.

| Method/path | Permission | Behavior |
|---|---|---|
| `POST prequotation-cancellation` | `handyman.operations.request.triage` | `{reason}`; 201 immutable actor/reason/time fact and terminal projection |
| `POST cancelled-predecessor` | same Operations triage permission | `{cancelledRequestId}`; current request must be a new `INTAKE` |
| `GET prequotation-history` | existing inspection/request read admission | cancellation and predecessor linkage, if present |
| `POST inspection-revisits` | **both** `handyman.operations.inspection.assign` and `handyman.operations.inspection.report.review` | pins preceding attempt/report, eligible Field target and active readiness version; 201 new assignment/attempt |
| `GET inspection-attempts` | existing inspection/request read admission | full physical and planned-attempt history in attempt order |

Existing read admission includes `tenant_company.read`,
`handyman.operations.request.read`, and dedicated inspection assign, submit or
review permissions. Every read and write applies the exact-Building guard;
a same-Client assignment to another Building is insufficient.

Cancellation/revisit precondition failures return **409
`HANDYMAN_PREQUOTATION_CONFLICT`**. Reasons are whitespace-normalized and bounded
10–500 characters. Malformed UUIDs/reasons are 400; missing permission or wrong
Building is 403. Duplicate cancellation is a conflict, not a second decision.
Any quotation thread (including DRAFT), any Execution Scope, or `REFERRED`
prevents cancellation. Existing quotation/PIC contracts are unchanged.

### Controlled revisit

Example request body:

```json
{
  "precedingInspectionId": "<latest physical inspection UUID>",
  "precedingReportId": "<latest accepted unsuccessful report UUID>",
  "assignedFieldUserId": "<eligible local Field user UUID>",
  "schedulingReadinessId": "<active same-request readiness version UUID>",
  "reason": "Customer has confirmed access to the previously inaccessible unit."
}
```

Eligibility is deliberately bounded:

1. Request is open, in `DIAGNOSIS`, before diagnosis/quotation/scope creation.
2. Latest physical attempt is `NOT_INSPECTABLE`; its latest report is accepted.
   Pending review is not sufficient. `RETURNED` uses the existing report
   correction route, on the **same** physical attempt.
3. Caller pins those exact IDs; stale history cannot authorize a new visit.
4. Readiness is ACTIVE and belongs to this request/Client. Its timezone remains
   derived by existing readiness authority from the Building. No booking fields
   are accepted or inferred.
5. Target is an active local user holding
   `handyman.field.inspection.report.submit`, with active exact-Building access.
6. Atomically supersede the current assignment, append its successor and the
   revisit planning fact, project `INSPECTION_REQUIRED`, and journal the decision.

The preferred version may subsequently be deactivated by normal readiness
supersession; its pinned window/identity cannot be rewritten. A newer preferred
version does not silently replace an already-recorded plan. Readiness remains
preference data, not permission to execute or a confirmed appointment.

### Physical outcome, reports, diagnosis

Existing `POST inspection` retains `{result, notes}` and adds:

- `unsuccessfulReason`: required for `NOT_INSPECTABLE`, one of `ACCESS_DENIED`,
  `CUSTOMER_UNAVAILABLE`, `UNSAFE_SITE`, `SITE_NOT_READY`, `OTHER`. Notes explain
  what prevented inspection. `INSPECTED` must omit the reason or use null.
- `evidenceSubmissionId`: optional existing **same-request intake** evidence
  reference. No new evidence engine, upload, post-approval QC stage or scope is
  created. The reference preserves existing evidence provenance.

Attempt number, revisit ID, captured assignment and inspector are server-derived.
Only the active assigned Field user may capture; a previous assignee cannot
capture a replacement's visit. Physical records stay immutable. `GET inspection`
returns the **latest** attempt; `GET inspection-attempts` exposes all attempts.

Report version numbers remain monotonically increasing per request. The first
report for each physical attempt must come from its inspector. Corrections require
`RETURNED`, keep the same physical ID, and preserve the global predecessor chain.
Acceptance is unique **per physical attempt**, not globally per request. Reviews
remain append-only and separated from the report submitter. Thus two accepted
failure/success reports are not contradictory: they concern different visits.

Shared service and SQL prerequisites require the latest successful inspection
and its latest accepted report. Accepted failure returns 409
`HANDYMAN_INSPECTION_NOT_QUOTABLE` for both diagnosis and DRAFT. Pending success
still fails acceptance checks. Diagnosis stores the successful report ID; DRAFT
also requires the existing matching diagnosis/F9 scope. No successful retry
bypasses PIC approval, scope authorization, pricing or direct-policy guards.

## Persistence, history and concurrency

Additive migrations **0449** and **0450**; baseline migrations **0441–0448 are
unchanged**. No historical report/review/inspection is rewritten or fabricated.
Legacy physical rows read as attempt 1, with null new provenance where it was not
recorded. Historical diagnoses from unsuccessful attempts are not repaired by
inventing a successful visit: they remain readable, fail new preparation, and
cannot use the diagnosis-free revisit path. An eligible request can instead be
cancelled and a new intake may reference it.

- 0449 adds immutable cancellation/link facts, atomic terminal projection, and
  request-row-locked cancellation guards on lifecycle, quotation and readiness
  writes, contact facts and new intake evidence submissions. Cancelled request
  rows cannot be updated, deleted or reopened. Facts cannot be reparented away
  from the terminal request to evade the guard. Evidence-engine retention remains
  outside this new submission restriction.
- 0450 extends physical inspections rather than introducing a second outcome
  engine. Request/attempt uniqueness replaces one-physical-row-per-request.
  Report acceptance is enforced by a trigger under the same parent lock, without
  rewriting historical reviews. SQL also validates physical/revisit/report
  binding and refuses unsuccessful diagnosis/DRAFT creation.
- The existing assignment supersession trigger is extended in 0450 to preserve
  an unchanged backward link when superseding second and subsequent assignments.
  Immutable identity, one ACTIVE assignment, forward/backward links and history
  protections remain intact; migration 0445 itself is untouched.
- Parent request locks serialize cancellation, planning, capture, review,
  diagnosis and DRAFT writes. Duplicate plans/reviews/cancellations are 409.
  Concurrent duplicate captures/diagnoses retain the existing source-state 400
  after the first writer advances the request; no second row is written.
- Audit uses existing append-only operational events in the same transaction.
  New event types are `HANDYMAN_PREQUOTATION_CANCELLED`,
  `HANDYMAN_CANCELLED_PREDECESSOR_LINKED`, and
  `HANDYMAN_INSPECTION_REVISIT_PLANNED`. Physical/report events retain their
  existing vocabulary and physical capture includes attempt/assignment links.

Migration 0449 rollback refuses to erase recorded cancellation history. Migration
0450 is deliberately forward-only: collapsing multiple physical attempts and
accepted reviews back to a single-attempt model is not a safe rollback. Use a
corrective forward migration, never delete authoritative history.

## Saved checkpoints and validation

- `87ab44d`: terminal cancellation authority; production typecheck PASS.
- `5b4b642`: controlled attempts and successful-inspection prerequisites;
  production typecheck PASS before PostgreSQL validation.
- `a389fd0`: focused PostgreSQL coverage, SQL alias correction and repeated
  assignment-chain support; initial seven tests PASS.
- `192dbaa`: signed-PIC revisit journey and updated unsuccessful prerequisite
  expectations; revisit E2E **1 PASS**, prerequisite file **8 PASS**.
- Expanded focused cancellation/revisit file: **8 PASS / 0 FAIL / 0 SKIP**,
  26.04 seconds, after readiness-history/delete/reparent guard hardening.
- Both existing signed-PIC inspection/direct journeys passed together earlier
  in this task: **2 PASS / 0 FAIL / 0 SKIP**, 37.05 seconds.
- Latest production `npm run typecheck`: **PASS**. OpenAPI YAML parse: **PASS**.

A final bounded combined run is recorded below after execution. Earlier test
failures exposed a fixture without a Building timezone, cancellation error-order
inconsistency, a PL/pgSQL `OLD` alias collision, and the existing assignment
trigger's restriction on subsequent supersessions. They were corrected, not
bypassed. Test-only historical prerequisite fixtures temporarily disable the new
SQL guard in an isolated transaction solely to emulate pre-migration rows; all
runtime journeys and denial/concurrency tests run with production guards enabled.

### Deliberately outside certification

No full suite, deployment, PR, SaaS tenant provisioning, Platform Admin changes,
confirmed revisit booking, reopening, or general historical-data repair. Signed
PIC tests use isolated test integrations and ephemeral secrets; they do not
certify live production integration provisioning. S1 staff approval remains 403;
B12 remains OFF. Existing historical G9/provisioning certification gaps are not
claimed resolved by this work.
