# CR-HM-04 PART 04 — Crew Assignment Boundary (FROZEN)

**Status: FROZEN on 2026-09-27, base commit `0cdfcda`.**
This document freezes the provider-authored crew-assignment boundary
per CR-HM-04 **F7 (Assignment Boundary)** and the **PART 04 STOP RULE**.

## 0. STOP RULE outcome

After reading the CR-HM-03 request/referral public types and the frozen
roadmap seams, **no authoritative assignable Handyman operational target
exists in this repository at implementation time**:

- The CR-HM-03 **request** is intake/lifecycle authority; the CR-HM-03
  **referral** (`SPECIALIST | OUT_OF_SCOPE`) is a triage/escalation
  decision — F7 states a referral does NOT automatically assign a
  provider/crew, and the roadmap states a referral cannot convert into
  FM workflow or silently expand scope.
- Existing FM / work-order entities are **not** Handyman assignment
  authority (FM Firewall).

Per the FROZEN STOP RULE: **no runtime assignment tables/services were
created; no job/work-order/task entity was invented; the FM work order
was not reused.** This document (and only this document) is the PART 04
deliverable. Runtime=0, migration=0, tests=0.

## 1. Ownership

Provider-authored crew assignment is owned **conceptually** by CR-HM-04
(F7): the provider selects an existing Handyman crew for a Handyman
operational target. CR-HM-04 does NOT own scheduling/time-slot selection
(CR-HM-05), permit/unit access, arrival verification (CR-HM-07/12),
work session, attendance, billable time, quotation, or provider
marketplace matching (CR-HM-21).

## 2. Deferral

Runtime **target binding is DEFERRED** until the owning Handyman CR
creates an authoritative assignable operational target. When that target
exists, CR-HM-04's assignment runtime binds crews to it without ever
inventing a substitute entity.

## 3. Future assignment contract (CONTRACT SHAPE ONLY — not persistence/runtime)

- `assignmentId`
- `clientId`
- `handymanProviderContextId`
- `handymanCrewId`
- `targetType`
- `targetId`
- `status` / history
- `assignedByUserId`
- server timestamps

## 4. Future assignment validation MUST require

- ACTIVE provider context
- ACTIVE crew
- exactly one valid current Lead (append-only lead history current row,
  ACTIVE member with ACTIVE worker context and non-null `userId`)
- target belongs to the same Client
- target is in an assignable lifecycle state
- provider is authorized for that target

## 5. Assignment must NEVER derive from

- a CR-HM-03 referral alone
- `service_catalog.category`
- an FM work order
- BM/customer direct worker selection

## 6. Author

The **provider authors assignment**. BM/customer can NEVER directly
assign a worker or crew. The actor remains an authenticated local user
with existing client/RBAC scope (F9) — never derived from vendor PIC,
workforce profile, tenantPic, channel attribution, or BM handoff
identity.

## 7. History

Assignment history MUST be **append-only** when the runtime exists
(F10): designation/replacement events journal as operational events;
old facts are never overwritten or hard-deleted.

## 8. Separation of concerns

Crew **membership** (CR-HM-04 PART 03, `handyman_crew_memberships`)
remains strictly distinct from:

- **assignment** (this contract, deferred),
- **attendance**,
- **work session** (CR-HM-08),
- **billable time** (financial domain / CR-HM-13).

A member joining/leaving a crew never implies assignment, presence,
work, or charge — and vice versa.

## 9. Target owner (roadmap-wording-derived)

Based ONLY on existing frozen roadmap wording, the **earliest CR
expected to create the authoritative operational target** is:

> **CR-HM-06 — Quotation & Customer Approval.**

Wording basis (HANDYMAN_CR_CODING_ROADMAP_v1.0.md, verbatim):

- Matrix row for CR-HM-06: *"…; **approval creates authorized execution
  scope**; SaaS package price firewall verified."*
- Dependency derivation notes: *"Scheduling (row 7) binds to the
  **authorized execution scope created by Customer Quotation Approval
  (row 9)**."*
- Matrix row for CR-HM-07: *"Verification contract … published against
  **approved/scheduled/assigned work** …"* — i.e. arrival verification
  consumes work that is already approved/scheduled/assigned.

No earlier frozen CR's wording creates an authoritative executable
operational target (CR-HM-02 = request intake; CR-HM-03 =
triage/referral decisions; CR-HM-04 = provider/worker/crew; CR-HM-05 =
scheduling/permit rules that themselves bind to CR-HM-06's scope). This
identification is wording-derived only; it does NOT redesign or renumber
the roadmap, and this PART does NOT create that target.

## 10. FM firewall

Preserved verbatim from CR-HM-04 governance: no FM vendor workflow,
no FM workforce processes, no FM work-order operational semantics are
adopted or reused for Handyman assignment. Assignment runtime, when it
lands, is Handyman-owned end to end.

---

*This document freezes wording and boundaries only. Any future
assignment runtime requires its own implementation PART after the
authoritative target (§9) exists.*
