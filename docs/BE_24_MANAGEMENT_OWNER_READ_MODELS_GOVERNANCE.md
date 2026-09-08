# BE-24 — Management & Owner Read Models (START GOVERNANCE)

> **Status:** START GOVERNANCE — documentation only. No BE-24 API, read model, business rule, migration, permission, or route is implemented by this step.
> **Baseline:** `main` / Arena branch `arena/01a00ee7-asentra-backend` at `0397ba0612856a2440be00a6010343f3b47520bf` (merged PR #26, CR-BE-API-01), on top of the merged BE-23 baseline.
> **Date:** 2026-08-17

## 1. Frozen boundary

BE-24 is a read-only composition and aggregation wave for management and owner consumers. It may query or delegate to BE-00–BE-23 authoritative domains, but it must not create a second operational authority, rewrite lifecycle rules, mutate source records, render charts, generate UI/mobile code, or introduce a BI warehouse/ETL layer.

Required read-model surfaces:

- Operations Command Center
- Daily Operations
- Pending Approval
- Critical Findings
- Work Order Summary
- Vendor Summary
- Workforce Summary
- Tenant Service Summary
- Portfolio Overview
- Building Performance
- Asset Health
- Operational KPI
- Utility Summary
- Financial Summary
- Vendor Performance
- Multi-Building aggregation

Every surface must support the caller's authoritative Client/Building scope. A requested Client or Building only narrows the caller's accessible Building set; it never widens access. Existing CR-BE-API-01 envelope, OpenAPI, evidence, permission, and data-isolation remediations remain mandatory.

## 2. Reusable baseline

### BE-23 reporting/KPI authorities

- `security-patrol-kpi`: accessible-Building rollup, UTC reporting window, grace-based missed/overdue semantics, zero-scope response.
- `security-finding-incident-kpi`: Finding/Incident/Handover counters with Building rollup and source-domain status semantics.
- `workforce-kpi`: headcount, assignment completion, overdue, derived man-hours, and per-workforce rows.
- `vendor-tenant-kpi`: vendor-work summary, per-vendor performance, and tenant-service fulfilment summary.
- `utility-kpi`: delegates consumption/abnormality/verification calculations to BE-18M; supports Building rollup and trends.
- `reporting-export`: neutral JSON KPI/table projection; never recalculates owning KPI values.

### Existing read models and source domains

- Engineering: `engineering-daily-operations`, `engineering-overview`, `engineering-reports`.
- Housekeeping: `daily-cleaning`, `housekeeping-reports`.
- Security: `security-daily-activity`, `security-reports`, plus BE-23 Security KPI services.
- Operations: `work-orders`, assignments/actions/completion/verification/history; `findings`, severity/classification/assignment/review/rework/closure/escalation; shared tasks and reviews.
- Approvals: Permit, Procurement, Tenant, Document, shared Review, Work Order verification, Vendor Work verification, Utility verification/tenant approval, Corrective Action verification, and Housekeeping supervisor inspection records.
- Asset: Asset lifecycle/classification/location, warranty, certification, history, maintenance/breakdown bindings, and Asset Failure incidents.
- People/services: Workforce reporting/KPI, Vendor work/KPI, Tenant Service Request/KPI.
- Utility/finance: BE-18M Utility Aggregation, BE-23 Utility KPI, and BE-19I building financial summary.
- Scope/security: `contextAccessService`, the BE-02F Building resolver, RBAC middleware, shared response/error contracts, and `docs/api/openapi.yaml`.

## 3. Governing invariants

1. **Read only:** no BE-24 operational source table and no mutation route.
2. **Source authority:** source statuses, priorities, severities, decisions, and available actions are copied or delegated; BE-24 never creates a competing lifecycle.
3. **BE-23 parity:** an existing BE-23 KPI value is copied from or computed by the owning BE-23 service at the same scope. BE-24 must not implement a parallel formula.
4. **Scope intersection:** effective Building scope is `caller-accessible Buildings ∩ requested Client/Building selection`. Explicit inaccessible scope is denied; no accessible scope returns a well-formed empty/zero read model.
5. **Client consistency:** a Building selector must belong to the selected Client. Multi-Client results remain partitioned by Client.
6. **Provenance:** every aggregate returns selected scope, actual `buildingScope`, period, and `asOf`/generated timestamp.
7. **No invented score:** Building Performance and Portfolio Overview expose authoritative measures and rates, not an unconfigured composite health/performance score or ranking.
8. **No presentation payload:** no chart type, colour, axis, layout, card, or widget metadata.
9. **Bounded detail:** command/queue detail rows are filterable, deterministic, and paginated or capped; headline aggregates are not built by fetching an unbounded list.
10. **Contract/security preservation:** new routes use the CR-BE-API-01 response/error/OpenAPI conventions and dedicated additive read permissions; source-domain manage permissions are never implied.

## 4. Proposed SMALL-PART breakdown

| Part | Read-model boundary | Primary reuse | Depends on |
|---|---|---|---|
| **PART 01** | **Management read-scope and contract foundation.** Shared Client/Building selector, accessible-scope intersection, period/as-of metadata, zero-scope convention, additive management read permission family, envelope/OpenAPI conventions. No business aggregate yet. | BE-02F/02G context access; CR-BE-API-01 | Baseline |
| **PART 02A** | **Daily Operations.** One cross-domain operational-day projection composed from Engineering daily operations, Housekeeping daily cleaning, and Security daily activity; source references and source statuses only. | BE-10A, BE-11C, BE-12F | 01 |
| **PART 02B** | **Work Order Summary.** Building/Client-scoped status, priority, work-type, assignment, completion/verification, active backlog, and bounded recent-item sections. No unsupported due-date/SLA claim. | BE-08 Work Order authority | 01 |
| **PART 03A** | **Pending Approval.** Unified discriminated queue and counters over existing approval/review authorities, preserving source IDs, approver, age, source permission, and available actions where already authoritative. | Permit, Procurement, Tenant, Document, Review/verification authorities | 01 |
| **PART 03B** | **Critical Findings.** Generic Finding-based critical queue/counters with source-domain binding, configured severity code/rank, status, escalation, assignee, and bounded detail. No duplicate Finding workflow. | BE-09 Findings and domain links; BE-21 escalation | 01 |
| **PART 04A** | **Workforce Summary.** Management projection of BE-23G headcount/assignment/man-hour values plus existing Workforce reporting dimensions; no new attendance/timesheet logic. | BE-23G; BE-03I reporting | 01 |
| **PART 04B** | **Vendor Summary + Vendor Performance.** Management projection of BE-23H vendor-work totals and per-vendor performance, with vendor master/compliance context only where already authoritative. | BE-23H; BE-06/15 | 01 |
| **PART 04C** | **Tenant Service Summary.** Management projection of BE-23H tenant-service intake/fulfilment values and bounded request detail; Work Order remains fulfilment authority. | BE-23H; BE-14E; BE-08 | 01 |
| **PART 05A** | **Asset Health — registry/compliance.** Lifecycle, classification, location, warranty, certification, and missing/expiring compliance coverage. No synthetic health score. | BE-05 Asset domain | 01 |
| **PART 05B** | **Asset Health — reliability/work.** Failure, breakdown, maintenance, and Asset-bound Work Order measures/details, preserving each source lifecycle. | BE-10 bindings; BE-21C; BE-08 | 05A, 02B |
| **PART 06A** | **Utility Summary.** Thin management projection over BE-23I/BE-18M totals, type breakdown, abnormality, verification, and trend. No consumption delta or sub-meter recalculation. | BE-23I; BE-18M | 01 |
| **PART 06B** | **Financial Summary.** Building and same-Client multi-Building projection over BE-19I billing, payment, receipts, vendor costs, expenses, outstanding balance, and income/cost values. | BE-19I Lite ERP | 01 |
| **PART 07** | **Operational KPI.** Cross-domain KPI envelope that delegates to completed BE-24 summaries and existing BE-23 KPI owners. Values retain owning-service names/semantics and provenance. | BE-23 F1/F2/G/H/I; 02–06 | 02A, 02B, 03B, 04A–C, 05B, 06A–B |
| **PART 08A** | **Building Performance.** Per-Building metric matrix built from Operational KPI, Asset Health, Utility, Financial, Workforce, Vendor, and Tenant summaries. No opaque composite score or ranking. | Completed BE-24 component services | 07 |
| **PART 08B** | **Portfolio Overview + Multi-Building aggregation.** Client/Property/Building hierarchy, per-Building comparison rows, Client-partitioned additive totals, and exact owning-service rollups for rates/KPIs. | BE-02 hierarchy; 08A; BE-23 scope-aware KPI services | 08A |
| **PART 09** | **Operations Command Center.** Final thin facade composing Daily Operations, Pending Approval, Critical Findings, Work Order Summary, and headline Operational KPI/Building Performance blocks. No direct domain SQL or new formula in the facade. | Completed BE-24 services | 02A–03B, 07, 08A |
| **PART 10** | **Contract/export completion and BE-24 final review.** Extend the neutral reporting-export registry/projections for approved Operations/Engineering/Housekeeping/management datasets, complete OpenAPI coverage, and verify scope/security/parity/boundaries. No PDF/Excel/chart rendering. | BE-23J; OpenAPI; focused tests | 02–09 |

Recommended execution order:

```text
01
├─ 02A ─┐
├─ 02B ─┼─ 05B ─┐
├─ 03A ─┤       │
├─ 03B ─┤       │
├─ 04A ─┤       ├─ 07 → 08A → 08B
├─ 04B ─┤       │          └→ 09
├─ 04C ─┤       │
├─ 05A ─┘       │
├─ 06A ─────────┤
└─ 06B ─────────┘

02–09 → 10 → BE-24 FINAL REVIEW
```

## 5. Scope-to-part mapping

| Required scope | Part |
|---|---|
| Operations Command Center | 09 |
| Daily Operations | 02A |
| Pending Approval | 03A |
| Critical Findings | 03B |
| Work Order Summary | 02B |
| Vendor Summary | 04B |
| Workforce Summary | 04A |
| Tenant Service Summary | 04C |
| Portfolio Overview | 08B |
| Building Performance | 08A |
| Asset Health | 05A/05B |
| Operational KPI | 07 |
| Utility Summary | 06A |
| Financial Summary | 06B |
| Vendor Performance | 04B |
| Multi-Building aggregation | 01/08B |

## 6. Dependencies and managed constraints

- Existing BE-23 services support one explicit Building or all accessible Buildings. PART 01 must introduce an internal, pre-authorized selected-Building scope/adaptor so Client-subset and arbitrary accessible multi-Building reads do not duplicate KPI formulas. Existing public BE-23 behavior must remain regression-locked.
- The approval sources do not share one complete approval registry. PART 03A is intentionally separate and must define a discriminated union with source-aware authorization rather than pretending all `PENDING` statuses are approvals.
- Generic Finding severity is Client-configured (`finding_severities.code/rank`). There is no platform critical-threshold setting. PART 03B must freeze a non-hardcoded selection contract before implementation; it may expose explicit severity selection/rank provenance but must not silently invent a global threshold.
- Work Orders have no authoritative due date/SLA. PART 02B may report lifecycle backlog and explicit caller-supplied age buckets, but must not label records overdue by an invented rule.
- Financial records have amounts but no currency dimension. PART 06B/08B must not sum money across Clients or claim currency conversion. Monetary portfolio output stays Client-partitioned and retains BE-19I amount semantics.
- Different Buildings may have different timezones while BE-23 KPI windows are UTC. BE-23-derived values retain existing UTC semantics; operational-day projections must state the delegated source convention rather than silently shifting windows.
- A composite Building/Portfolio score, weighting, target, or benchmark is not configured in BE-00–BE-23. PART 08 exposes a transparent metric matrix only unless a future authoritative configuration domain supplies scoring rules.
- Org/Department/Team/Position effective-context expansion identified as G01/G02 in API Contract Checkpoint 01 is not required for the frozen Client/Building-scoped BE-24 surfaces. Existing Workforce dimensions may be used only inside the already authorized Building scope. This is not a blocker for PART 01.

## 7. Readiness

- Baseline and reusable authorities are present.
- CR-BE-API-01 P1–P4 implementations are merged in the baseline and must be preserved.
- No blocker prevents PART 01. Downstream semantic constraints are isolated to their named parts and have safe no-invention boundaries above.
- **Ready for first BE-24 PART: YES — PART 01 only.**

No repository test, migration, build, server, PR, or merge was run/created for this governance step.
