# CR-HM-03 Amendment 01 — Pre-Quotation Inspection Authority (Proposal)

| Field | Value |
|---|---|
| Status | **OWNER PROPOSED — not ratified or frozen** |
| Review baseline | `fe9ba93fbad5fb01d25b732d406bf19a5973facd` |
| Companion | [`CR-HM-INSPECTION-01_PRE_QUOTATION_FIELD_INSPECTION_AUTHORITY.md`](CR-HM-INSPECTION-01_PRE_QUOTATION_FIELD_INSPECTION_AUTHORITY.md) |
| Reconciliation | [`CR-HM-INSPECTION-01_FINAL_AUTHORITY_RECONCILIATION.md`](CR-HM-INSPECTION-01_FINAL_AUTHORITY_RECONCILIATION.md) |

## Amendment intent

This is an explicit, narrow amendment proposal for the frozen CR-HM-03 F8 boundary and its roadmap closure. It applies only to the pre-quotation workflow for requests triaged `INSPECTION_REQUIRED`. It does not silently edit the frozen CR-HM-03 text or the roadmap, and it does **not** renumber any roadmap row, glossary entry, part, or API operation. The existing CR-HM-03 roadmap row remains the row to which this addendum is attached after ratification.

## Proposed F8 amendment

1. **Preserve route paths and reads.** Existing triage, inspection, diagnosis, and referral paths remain. Existing GET behavior and historical records remain readable under current scoped read authority.
2. **Narrow inspection-path writes.** For cutover `INSPECTION_REQUIRED` requests, `POST /inspection` must delegate to the new assigned-Field authority and require `handyman.field.inspection.report.submit` plus the active request assignment and exact Building scope. `tenant_company.manage` alone cannot create a new in-scope physical inspection.
3. **Gate inspection-path diagnosis.** Preserve the existing `POST /diagnosis` path and its current `tenant_company.manage` permission for compatibility. For a request whose persisted triage disposition is `INSPECTION_REQUIRED`, the service must require an `ACCEPTED` inspection-report version and persist its report id on the new 0382 diagnosis row. For persisted `DIAGNOSIS` requests, the direct-diagnosis path remains unchanged and does not require a report.
4. **Add a bounded assignment/report/review surface.** Mount it separately from the existing eight-operation lifecycle router. The assignment write uses `handyman.operations.inspection.assign`; Field report submission uses `handyman.field.inspection.report.submit`; review uses `handyman.operations.inspection.report.review`. Each new code is added to the existing permission registry and unassigned-by-default set. No role, auto-grant, provisioning API, or generic RBAC framework is added.
5. **Reviewer separation.** The user reviewing a report version must differ from that version's submitting Field user. No additional separation from the Operations assigner is imposed by this proposal.
6. **Draft prerequisite only.** An accepted report linked from the 0382 diagnosis is required before initial quotation DRAFT creation and later DRAFT revision for `INSPECTION_REQUIRED`. No quotation issue gate, PIC approval change, or CR-HM-04 Execution Scope change is made.

## Proposed additive F1/F2 boundaries

- F1 request statuses remain unchanged. Assignment, report, review, and `NOT_INSPECTABLE` resolution are separate request-scoped facts; none silently adds `CANCELLED`, `REPORT_ACCEPTED`, or other request status.
- Preserve 0381 and 0382 as immutable historical records. Add report version/review/assignment records and a nullable 0382 `source_inspection_report_id` via new additive migration(s); existing/direct diagnosis rows remain null and are never backfilled.
- Reports, estimates, review decisions, assignments, and operations resolutions are append-only. Correction creates a new report version. Reassignment creates a new assignment fact with a mandatory reason and a link to the superseded assignment.
- F3 remains unchanged: no evidence reference or parallel evidence subsystem. F6 operational events remain audit-only; the rows above remain the business authority. F7 uses the authenticated local `users.id` and request-derived exact Building scope. F9 classification remains server-derived.
- `NOT_INSPECTABLE` never authorizes a quotation DRAFT. Operations may select reschedule, reassignment, cancellation, or escalation, but the outcome model is not yet freeze-ready: a second physical visit would require an explicit F2 amendment to the 0381 one-row/no-reinspection rule; cancellation and escalation need a defined terminal disposition/target; actual scheduling remains CR-HM-05 authority.

## Roadmap treatment

Keep `HANDYMAN_CR_CODING_ROADMAP_v1.0.md` row numbers and glossary numbers unchanged. After approval, attach a dated reference to this amendment to the existing CR-HM-03 row/contract package; do not insert or renumber a roadmap row. Until ratified, the existing frozen roadmap and CR-HM-03 F8 remain authoritative.

## Ratification gates

This proposal is **not** the ratification itself. Do not mark CR-HM-INSPECTION-01 or CR-HM-03 F8 frozen until the owner resolves:

- whether `NOT_INSPECTABLE` rescheduling can create another physical inspection attempt and, if so, approves the F2 amendment/attempt model;
- cancellation and escalation disposition semantics;
- the cutover rule for pre-existing uninspected requests without report facts;
- the permitted reassignment timing relative to an open/returned/accepted report; and
- whether the existing authenticated diagnosis writer and server diagnosis timestamp remain the diagnosis actor/time after the accepted report is linked.

The direct-quotation service-eligibility policy remains a separate pending authority and is not part of this amendment.
