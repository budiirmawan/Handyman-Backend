# CR-HM-05 PART 05 — Deferred Target-Binding Contract (FROZEN)

**Status: FROZEN on 2026-09-27, base `47c0bc0`.**
Contract-shape-only freeze under the CR-HM-05 Decision Freeze
(F1/F2/F3/F9). NO runtime, NO migration, NO test, NO OpenAPI, NO roadmap
change. Complements `CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md` (which
remains unchanged).

| Token | Value |
|---|---|
| TARGET_AUTHORITY | CR-HM-06_EXECUTION_SCOPE |
| SCHEDULING_SEMANTIC_AUTHORITY | CR-HM-05 |
| CREW_ASSIGNMENT_AUTHORITY | CR-HM-04 |
| ARRIVAL_VERIFICATION_AUTHORITY | CR-HM-07 |
| TARGET_BINDING_RUNTIME | DEFERRED |
| PLACEHOLDER_TARGET | FORBIDDEN |
| FM_WORK_ORDER_REUSE | FORBIDDEN |

## 1. Target authority

CR-HM-06 **Customer Quotation Approval** creates the authoritative
Handyman execution scope (frozen roadmap wording: *"approval creates
authorized execution scope"*). **Before that entity exists, target
binding MUST NOT exist**: no placeholder `targetId`, no nullable fake
binding, no FM work-order reuse as a stand-in target.

## 2. Scheduling authority

CR-HM-05 remains the sole authority for: scheduling readiness; the
preferred window model; timezone semantics (building-authoritative,
never caller input); reschedule semantics/history (supersede + immutable
row chains + bounded optional reason). CR-HM-06 must NOT redefine any
of these semantics.

## 3. Future target-binding shape (CONTRACT SHAPE ONLY — not persistence/runtime)

- `bindingId`
- `clientId`
- `executionScopeId`
- `handymanSchedulingReadinessId`
- `scheduledWindowStart`
- `scheduledWindowEnd`
- `timezone`
- `status` / history
- `boundByUserId`
- server timestamps

## 4. Binding rules (future, mandatory validation set)

A target binding is valid only when ALL hold:

1. the authoritative CR-HM-06 execution scope EXISTS;
2. it belongs to the **same Client**;
3. it is in a **schedulable** lifecycle state;
4. an **ACTIVE** scheduling readiness exists for the lineage request;
5. the selected scheduled window is valid (`start < end`, business rules);
6. the **timezone remains server-authoritative** (derived from the
   location authority, never caller input);
7. execution scope/request lineage **agrees** (the scope's request is
   the readiness' request);
8. the authenticated actor holds the required **Client/RBAC** authority.

## 5. Window semantics

**Preferred window** — the customer/request scheduling preference
(CR-HM-05 readiness fact, append-only history). **Scheduled window** —
the execution commitment against the CR-HM-06 scope. They are NOT
automatically identical: a future binding may select/confirm a
scheduled window per authorized business rules, but MUST preserve
provenance back to the **readiness version** used
(`handymanSchedulingReadinessId` points at the exact immutable row).

## 6. Reschedule (target-bound)

A future target-bound reschedule must preserve old binding/window →
new binding/window (append-only; historical binding facts are NEVER
overwritten) and reference the applicable CR-HM-05 readiness/history
provenance (the readiness row whose window informed the change —
itself part of an immutable supersede chain).

## 7. CR-HM-04 interlock

The same CR-HM-06 execution scope is also the legitimate future target
for CR-HM-04's deferred provider-authored crew assignment. The two
authorities remain strictly separate:

- **CR-HM-04** owns crew-assignment authority,
- **CR-HM-05** owns schedule/time-window authority,

and neither may silently create the other (a schedule binding never
creates an assignment; an assignment never creates a schedule binding).

## 8. CR-HM-07 firewall

Scheduled/bound work ≠ verified arrival. CR-HM-07 still exclusively
owns: QR/challenge proof; expected-location verification; geofence/risk
signals; the verified-arrival outcome.

## 9. FM firewall

Handyman scheduling is NEVER bound to FM `work_orders` merely because
they already exist; no FM scheduling lifecycle is adopted.

## 10. Activation rule

This contract becomes implementable only AFTER CR-HM-06 has created and
certified the authoritative execution-scope runtime/API. It MUST NOT be
activated during CR-HM-05. When activated, the owning integration step
implements the §3 shape against §4 rules without redefining CR-HM-04 or
CR-HM-05 semantic authority.

---

*This document freezes contract wording only. Runtime activation is an
explicit post-CR-HM-06 step, symmetric to CR-HM-04 PART 04's assignment
binding.*
