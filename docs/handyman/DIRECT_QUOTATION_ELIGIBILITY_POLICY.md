# Handyman direct-quotation eligibility — owner-authorized policy

## Baseline and decision

Baseline: `f01f9edbb95b9343aaebf5b8ed1b652c9daab00f`, verified locally and on
`origin/arena/d04dc185-handyman-backend` with a clean worktree.

Owner rule: **inspection is the default**. Direct quotation is permitted only
when the selected service explicitly allows it and Operations explicitly confirms
sufficiently clear scope with a meaningful exception reason. This decision
supersedes the earlier direct-eligibility deferral; it does not change the
inspection/report, PIC approval, issue or Execution Scope authorities.

## Configuration and API

Existing catalog POST/PATCH routes accept `inspectionPolicy`:

- `INSPECTION_REQUIRED` — default for new, existing and unconfigured services.
- `DIRECT_ALLOWED` — permits an Operations exception; does not force one.

No new endpoint, permission, role or authentication mechanism. Catalog writes use
existing `service_catalog.manage` and Client scope. Explicit policy changes are
also permission-checked inside the service. Existing create/update audit events
include the resulting policy. Omitted PATCH policy leaves configuration unchanged;
null or unknown values are rejected, not coerced into permission.

Example authorized triage body on the existing request triage route:

```json
{
  "disposition": "DIAGNOSIS",
  "note": "Operations reviewed the documented scope.",
  "scopeClarityConfirmed": true,
  "directQuotationReason": "Confirmed unit measurements and fixed replacement specification remove the need for a site inspection."
}
```

For direct triage:

- The selected service comes from the persisted request, never the body.
- The service must exist, be ACTIVE, belong to the request Client and explicitly
  permit `DIRECT_ALLOWED`. Missing, foreign, inactive or unconfigured services
  fail closed.
- The actor must be ACTIVE, have `handyman.operations.request.triage` and exact
  request-Building access. Generic manage or Field authority is insufficient.
- `scopeClarityConfirmed` must be literal boolean `true`.
- A separate `directQuotationReason` is required: whitespace-normalized,
  20–500 characters, at least three words. The normal triage note does not grant
  authority. These structural checks cannot prove that the human assessment is
  factually correct; Operations remains accountable for its business meaning.
- Omitting disposition still chooses `INSPECTION_REQUIRED`, even on a
  `DIRECT_ALLOWED` service. Irrelevant direct-exception fields are not recorded
  as confirmation for the inspection path.

## Persistence, concurrency and boundaries

Additive migration **0448_handyman_direct_quotation_policy** adds the catalog
policy and five nullable fields to the existing append-only triage table:

- `service_inspection_policy`
- `policy_service_catalog_id`
- `policy_catalog_updated_at`
- `scope_clarity_confirmed`
- `direct_quotation_reason`

The existing triage actor and server timestamp supply decision provenance. The
snapshot describes the effective service eligibility; the immutable triage
**disposition** records which path Operations chose. PostgreSQL retains the exact
catalog timestamp; the API uses the existing JavaScript/ISO millisecond timestamp
representation. No separate authorization ledger or synthetic acceptance exists.

Triage holds the request lock and reads catalog policy under `FOR SHARE`, so a
concurrent catalog edit cannot create a mixed/stale decision. Snapshot insertion,
status projection and existing operational audit are one transaction. Policy
configuration and its audit are likewise transactional. Audit metadata identifies
policy/source/confirmation and links to triage; it does not duplicate the reason.

Direct diagnosis, initial DRAFT and every DRAFT revision require the saved
same-request/service authorization. They **do not re-evaluate current catalog
policy**. A later restriction, allowance or deactivation is not retroactive
revocation/authorization of a decision already recorded. New triage decisions use
the current ACTIVE-service policy. Preparation actors still require existing
`tenant_company.manage` and exact Building scope, including service-call checks
on the direct path. F9 diagnosis quoteability remains required.

Database INSERT guards reject unsupported direct triage, diagnosis and DRAFT
inserts; existing immutable-row protections remain. Inspection-required requests
continue through PART C's accepted-report/source/INSPECTED gate without alteration.
No issue-time policy gate is added. S1, B12 OFF, PIC binding/session and the
approval-to-Execution-Scope transaction are unchanged.

Error behavior:

- 409 `HANDYMAN_DIRECT_QUOTATION_NOT_AUTHORIZED`: disallowed service at direct
  triage, or absent/mismatched saved authorization at preparation.
- 400 validation: missing/non-boolean confirmation, missing/short/overlong reason
  or invalid configured policy.
- Existing permission/scope, state, uniqueness and F9 errors retain their codes.

## Historical compatibility and rollout

No historical triage, diagnosis or quotation is rewritten or backfilled. Old
triage rows have null new provenance fields. Historical reads and already-created
versions remain available; issue/PIC processing is not retroactively gated here.

A legacy note-only direct decision is **not** implicitly authorized by today's
catalog setting. New diagnosis/DRAFT/revision writes from such a request fail
closed. Grandfathering or remediation of these immutable decisions would require
separate explicit authority; this implementation does not fabricate it.

Migration 0448 must be applied before deploying code that selects its new columns.
No deployment occurred. All existing migration files, including 0441, are unchanged.

## Focused validation — actual results

Production: `npm run typecheck` — **PASS**.
OpenAPI YAML parse and `git diff --check` — **PASS**.

Final PostgreSQL run (only these four files):

```sh
NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1 tests/handyman-direct-quotation-policy.test.ts tests/handyman-direct-quotation-journey.test.ts tests/handyman-inspection-prerequisite.test.ts tests/handyman-inspection-integrated-journey.test.ts
```

**17 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED**, exit code 0; approximately 76 seconds.

- **7 policy PostgreSQL tests:** defaults, smuggled policy, absent/unclear scope,
  reason bounds, actor/Building/configuration permission checks, saved policy
  surviving catalog edits, exact persisted timestamp, catalog/triage audit,
  missing/inactive service, raw INSERT denial, audit-failure rollback/retry,
  observed catalog-lock contention, and historical migration preservation.
- **1 new direct E2E:** signed Care intake → configured service → explicit
  Operations decision → diagnosis/DRAFT/commercial line → issue with no binding
  (B12 OFF) → signed PIC HTTP session → explicit binding → PIC APPROVE → one
  AUTHORIZED Execution Scope. No assignment, physical inspection, report or review
  rows are created. Includes staff 403, credential/assertion replay denial,
  unbound approval refusal, binding/decision replay, changed-body conflict,
  premature-scope denial and immutable policy/intake history.
- **8 PART C regression tests:** accepted-report and historical safeguards still
  pass. Its direct-path fixture now explicitly opts into the owner-authorized
  policy and Operations confirmation instead of asserting the old deferral.
- **1 unchanged inspection E2E:** Care → triage → Field → returned/corrected and
  accepted report → diagnosis → quotation → signed PIC approval → Execution Scope.

The first policy test run exposed SQL whitespace-regex escaping and PostgreSQL
microsecond versus JavaScript millisecond timestamp mismatch in the new guard.
Both were corrected before the passing runs. Expected test-only audit-fault and
replay/constraint rejection logs are not skipped or suppressed assertions.

## Commit checkpoints

- `481e9ff` — service policy, immutable Operations authorization, additive schema
  and preparation enforcement; production typecheck passed.
- `8fa1395` — PostgreSQL validation, concurrency/rollback coverage and snapshot
  precision correction; seven policy tests passed.
- `f639b10` — direct signed-PIC E2E; direct and inspection journeys both passed.
- Completion commit carries this report, OpenAPI reconciliation and the final
  focused regression fixture update.

## Remaining certification limits

- Test-only channel integrations, narrow synthetic RBAC grants and ephemeral
  signing secrets do not certify deployed Operations provisioning, production
  secret distribution/rotation, a live BM host or frontend.
- No full suite, repo-wide fixture conversion, load test, production-history
  upgrade rehearsal, PR or deployment. Older direct-path callers/fixtures that
  assumed a note alone was sufficient must adopt the new explicit policy and
  confirmation contract; they were not broadly audited in this task.
- Historical null-provenance remediation and NOT_INSPECTABLE revisit/disposition
  authority remain separate. No new tenant provisioning or Platform Admin path.

## Recovery check and bounded revalidation — 2026-10-11

The follow-up named `481e9ff` as the last confirmed push. Local and remote
verification instead found `3332e654bf44967c42768730bcc0f7ccdda042f9` on the same
`arena/d04dc185-handyman-backend` branch, with a clean worktree. `481e9ff` is an
ancestor; the policy-validation and direct-E2E commits survived and were already
pushed. No restoration, rewrite or new recovery checkpoint was necessary.

Re-ran only these two files against isolated embedded PostgreSQL using the same
`NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true` environment and
`tsx --test --test-concurrency=1` runner:

- `tests/handyman-direct-quotation-journey.test.ts` — **PASS**.
- `tests/handyman-inspection-integrated-journey.test.ts` — **PASS**.

Actual aggregate: **2 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED**, exit code 0,
approximately 46.7 seconds. `npm run typecheck` also **PASS**, exit code 0.
The seven policy tests were not repeated. No implementation/test correction was
needed; this follow-up changes only the validation record. No runtime blocker was
encountered. Production provisioning, secret delivery, live BM/frontend and broad
regression/deployment certification limits above remain unchanged. No full suite,
repo-wide audit, PR or deploy.
