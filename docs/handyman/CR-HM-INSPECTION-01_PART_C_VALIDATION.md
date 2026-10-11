# CR-HM-INSPECTION-01 — PART C implementation and validation

## Scope and recovery

PART A (`66093e2`) and PART B (`4cbd0e6`) were restored by fast-forward, not
reimplemented. PART C's previous local work was unavailable. The owner explicitly
authorized this bounded reimplementation on `arena/d04dc185-handyman-backend`.

This change follows the final authority reconciliation's separate diagnosis
write and source-reference approach. It does not mark the broader proposal or
F8 amendment FROZEN, or settle the remaining business-policy decisions.

## Runtime behavior

- Persisted `INSPECTION_REQUIRED` triage selects the gate, not current request
  status, client input, report absence or an audit event.
- Diagnosis requires the latest report to have PART B's immutable `ACCEPTED`
  review. The service resolves its id; caller-supplied provenance is ignored.
  The authenticated diagnosis writer, server timestamp and F9 derivation remain
  unchanged. Review acceptance does not itself create a diagnosis.
- Additive migration `0447_handyman_diagnosis_inspection_source` adds nullable
  `source_inspection_report_id` with a same-request composite FK. An INSERT-only
  guard requires the latest accepted same-request source for new inspection-path
  diagnoses. Existing rows are neither backfilled nor rewritten; the existing
  diagnosis immutability protections remain in force.
- Initial quotation DRAFT and every DRAFT revision require accepted latest
  report, matching diagnosis source, physical `INSPECTED` result and quoteable
  diagnosis scope. `NOT_INSPECTABLE` cannot authorize a DRAFT even if accepted.
- Request locks serialize the gate with PART A/B and diagnosis. Revisions take
  the request lock before the quotation lock; version allocation remains under
  the quotation lock.
- Historical reads and existing versions remain available. Legacy null-source
  inspection diagnoses do not grant new-DRAFT authority, even if a report is
  accepted later. No inferred grandfathering or synthetic acceptance.
- Direct `DIAGNOSIS` has null provenance and unchanged policy. No new service
  eligibility criteria, issue gate, permissions, roles or endpoints are added.

New 409 codes: `HANDYMAN_INSPECTION_ACCEPTED_REPORT_REQUIRED`,
`HANDYMAN_INSPECTION_DIAGNOSIS_SOURCE_REQUIRED`,
`HANDYMAN_INSPECTION_NOT_QUOTABLE`. Existing F9/state errors retain their existing
400 contracts. OpenAPI documents the nullable, read-only provenance and gates.

## Focused validation

```sh
npm run typecheck
NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-concurrency=1 tests/handyman-inspection-prerequisite.test.ts
```

Result: production typecheck passed; **8 focused PostgreSQL tests passed, zero
failures, zero skips**. Only this PART C test file ran; no full suite.

Coverage:

1. New migration down/up in an isolated test transaction, historical diagnosis
   preservation, composite FK, no backfill and legacy draft/revision denial.
   Historical DRAFT can still issue without a PIC binding: B12 remains OFF and
   PART C is not an issue-time gate.
2. Missing, pending, returned and pending-correction report denial on diagnosis,
   initial DRAFT and revision, with no diagnosis/status/audit/version side effects.
3. Accepted correction provenance, ignored caller source, separate diagnosis
   actor and audit metadata, concurrent diagnosis exclusion and revision numbering.
4. Accepted `NOT_INSPECTABLE` denial for both DRAFT writers.
5. Non-quoteable F9 scope denial, including revision.
6. Direct diagnosis with null source and successful initial/revision DRAFT.
7. Existing exact-Building and permission denials; unauthenticated diagnosis;
   S1 staff approval 403; DRAFT creation does not create Execution Scope.
8. Database rejection of null, nonexistent, pending, returned and cross-request
   source references; linked diagnosis UPDATE/DELETE remains prohibited.

Migration 0441 and all other existing migration files are untouched. PIC
approval, binding/session, Execution Scope and issue service implementations are
unchanged. No PR, deploy or full-suite run.

## Remaining boundaries

- Direct-quotation service eligibility remains deferred.
- `NOT_INSPECTABLE` rescheduling, repeated visits and Operations disposition
  authority are outside PART C; no new status or bypass is introduced.
- Legacy null-source diagnoses cannot be relinked through this append-only
  authority. A grandfathering/remediation policy would require separate explicit
  authorization; this change does not invent one.
- Broader regression suites and deployment validation were intentionally not run.
