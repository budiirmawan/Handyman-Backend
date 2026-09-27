# CR-HM-05 — START GOVERNANCE (Scheduling, Permit & Unit Access)

**Status: BLOCKED_FOR_DECISION on 2026-09-27, base `e5203ec`.**
Governance-only document. NO coding, NO migration, NO test, NO OpenAPI
change. Frozen roadmap wording is quoted, never changed. Read scope was
strictly limited to: frozen roadmap CR-HM-05 row + derivation notes,
CR-HM-00 capability-map rows (Scheduling / Permit), CR-HM-01 channel
attribution public seam, CR-HM-02 service-request public seam, CR-HM-03
diagnosis/referral final-state seam, CR-HM-04 provider/worker/crew
public seam, and the nearest existing scheduling/permit/access modules.

---

## 1. REUSE (verified existing seams — used, never duplicated)

- **Building/floor/unit/space masters** — `buildings`, `floors`,
  `areas`, `rooms` (unit), `spaces` modules are the existing
  authoritative location chain. Handyman NEVER creates a parallel
  location tree.
- **Tenant access context** — `tenant_building_contexts`
  (tenantCompanyId ↔ buildingId, effective window, status) and
  `tenant-space…` relationships anchor which tenant may be served at
  which building/space.
- **Internal scope enforcement** — `context-access`
  (`canAccessClient`, building access) + `building_assignments`: the
  same server-side scope convention CR-HM-02/03/04 consume.
- **CR-HM-01 attribution / CR-HM-02 request context** — the immutable
  attribution (`buildingId`, `spaceId`, `tenantCompanyId`, `tenantPicId`)
  and the request context snapshot are the ONLY Handyman-owned
  location/customer handles; they are read, never re-authored.
- **Schedule primitives as PATTERN** — `schedule_definitions`
  (start_at/end_at TIMESTAMPTZ, `timezone` TEXT, range CHECK,
  ACTIVE|INACTIVE, uniqueness per target) and `schedule_recurrence`
  (DAILY/WEEKLY/MONTHLY rules) demonstrate the repo's
  timezone/time-window + recurrence conventions. NOTE: their
  `target_type` CHECK is hard-bounded to
  FORM_TEMPLATE/FORM_VERSION/CHECKLIST_TEMPLATE — they can furnish
  pattern and recurrence semantics, NOT the Handyman target binding.
- **Permit engine as PATTERN/integration** — BE-20A–20G (`permits`
  + applications/work-contexts/safety/approval/validity/workers/
  equipment): contractor-context indirection and validity/approval
  seams are repo-canonical.
- **Visitor suite** — `visitors` / `expected-visitors` /
  `contractor-visitors` / pass & binding modules anchor the existing
  visitor/worker identity relationship for later access decisions.
- **CR-HM-04 provider/worker/crew seams** — provider context, worker
  context, crew exist for later scheduling against an assigned crew,
  but the matrix lists NO CR-HM-05 dependency on CR-HM-04 ("—"),
  and crew ASSIGNMENT itself remains deferred (§B2).

## 2. EXTEND

- **Scheduling semantics** — Handyman-specific scheduling rules/
  lifecycle EXTEND the repo conventions (timezone derived from
  location authority, not free input; bounded Handyman statuses;
  reschedule = supersedes-with-history, never overwrite) WITHOUT
  touching `schedule_definitions` target constraints.
- **Permit context** — Handyman-scoped permit readiness EXTENDS the
  contractor-context indirection idea toward a Handyman provider
  context, keeping tenant/unit service-access bounds; the FM
  permit-to-work lifecycle (DRAFT/CANCELLED + safety/equipment/
  approval workflow) is NOT absorbed.

## 3. NEW (minimal; all candidates pending the §8 decision)

- **Handyman scheduling rules/lifecycle + readiness seam** —
  targetType-bindable CONTRACT surface implementing what the frozen
  roadmap rowing itself assigns to CR-HM-05 ("scheduling rules/
  lifecycle and permit readiness"). Target BINDING is NOT part of
  this NEW surface (see B1).
- **Handyman permit-readiness bounded seam** — tenant/unit service
  access permit reference (jurisdiction/building-rule driven), not a
  permit-to-work clone.
- **Unit-access readiness** — access window + approval/authorization
  seam over existing building/space + tenant-context authorities.

## 4. THREE CAPABILITIES — mapping

### A. Scheduling / Rescheduling

- **Reusable primitives**: time-window + timezone conventions,
  recurrence semantics, bounded status vocabulary (pattern only —
  existing tables are form/checklist-target-bound).
- **Authoritative Handyman entity that may be scheduled**: **NONE
  EXISTS TODAY.** CR-HM-02 request is intake/lifecycle (statuses
  INTAKE|TRIAGE|INSPECTION_REQUIRED|DIAGNOSIS|READY_FOR_NEXT_STEP|
  REFERRED) and CR-HM-03 frozenly denies that a request/referral is a
  job; CR-HM-04 PART 04 verified no authoritative operational target
  exists. The roadmap's own wording assigns that target to CR-HM-06:
  *"approval creates authorized execution scope"* and *"Scheduling
  (row 7) binds to the authorized execution scope created by Customer
  Quotation Approval (row 9)"*.
- **Lifecycle/state requirements**: only a target in an assignable,
  authorized lifecycle state may be scheduled (deferred contract).
- **Timezone/time-window semantics**: timezone derives from the
  building/location authority; windows are absolute TIMESTAMPTZ +
  duration; recursion is out unless explicitly approved (repo
  recurrence is pattern-only).
- **Reschedule/history semantics**: append-only supersession history
  (old slot fact never overwritten), mirroring PART-lead-history
  conventions.
- **Actor authority**: authenticated local user + existing client/RBAC
  scope (CR-HM-03/04 F9-style); BM/customer never schedules directly.

### B. Permit

- Map: BE-20A–20G is **FM Permit-to-Work** (contractor contexts
  VENDOR_CONTRACTOR/TENANT_CONTRACTOR, safety requirements, equipment,
  approval bindings, validities, evidence). Its lifecycle and workflow
  vocabulary are FM-maintenance-oriented.
- Verdict: **REUSE as pattern/infrastructure; the Handyman surface is
  NEW and bounded** (§3). Handyman permit remains strictly a
  tenant/unit service-access readiness fact. FM permit-to-work
  workflow is NOT absorbed (firewall).

### C. Unit access

- **Building/floor/unit/space authority**: existing masters (§1) + the
  CR-HM-01/02 immutable attribution/request snapshots as the only
  Handyman context handles.
- **Customer/tenant context**: `tenant_companies` + tenant building
  context (+ request-carried `tenantCompanyId`/`tenantPicId`).
- **Access window**: NEW bounded readiness seam over location
  authority (§3); derives from building rules, never free input.
- **Approval/authorization seam**: reuse permit-engine approval/
  validity pattern; owner = Handyman provider-context authorization
  (bounded), not FM workflow.
- **Visitor/worker identity relationship**: existing visitor suite
  anchors identity; CR-HM-04 worker contexts (incl. login-less
  helpers) are the workforce handles — no new person authority.

## 5. BLOCKERS

- **B1 (PRIMARY, hard)**: An authoritative **schedulable** Handyman
  operational target does NOT exist before CR-HM-06 (identical fact
  basis as CR-HM-04 PART 04's missing **assignable** target: no
  Handyman job/work-order exists; the service request is intake, the
  referral is a decision). A target-bound scheduling runtime before
  CR-HM-06 would equate to inventing that target — explicitly
  forbidden.
- **B2 (interlock)**: CR-HM-04 PART 04 already deferred crew-
  assignment target binding to the same CR-HM-06 authority; the
  scheduling binding and the assignment binding share ONE target and
  must stay consistent when it lands.

## 6. DEPENDENCIES

Frozen roadmap: CR-HM-05 backward deps = **"—"**, consumers =
CR-HM-07/17/18; derivation notes document the contained edge
(scheduling → authorized execution scope from row 9) and state
*"CR-HM-05 delivers scheduling rules/lifecycle and permit readiness;
the authorized-scope scheduling binding closes when CR-HM-06 lands"*.

Verified dependency reality: this containment is EXACTLY the PART-04
pattern (rules/readiness now, target binding deferred). CR-HM-07
already depends backward on CR-HM-04+CR-HM-05+CR-HM-06, so placing the
partial CR-HM-05 before CR-HM-06 introduces no forward-reference
violation in the frozen order — PROVIDED target binding is deferred
explicitly, mirroring CR-HM-04 PART 04.

## 7. AUTHORITY

| Concern | Owner |
|---|---|
| Location chain (building/floor/area/room/unit?space) | Existing masters; Handyman shadow copies FORBIDDEN |
| Customer/tenant context | `tenant_companies` + tenant building context; request snapshot immutable |
| Scheduling rules/readiness | CR-HM-05 (Handyman-owned) |
| Schedulable/assignable execution target | **CR-HM-06** (per frozen roadmap wording; NOT created by CR-HM-05) |
| Crew assignment binding | CR-HM-04 contract; target binding deferred (PART 04 doc) |
| Permit-to-work workflow | FM/BE-20 — excluded |
| Arrival/location verification | CR-HM-07 |
| Work session/attendance/billable | CR-HM-08/13 — out of scope |
| Quotation | CR-HM-06 — out of scope |

## 8. LIFECYCLE_GAPS

1. No Handyman entity passes through a *schedulable* lifecycle state
   today (request terminal/business states end at
   READY_FOR_NEXT_STEP/REFERRED; no APPROVED/SCHEDULED exists).
2. Permit statuses for a Handyman-bound readiness case are UNDEFINED
   (engine statuses are FM-oriented; bounded Handyman vocabulary must
   be frozen before coding).
3. Access-window/approval read-model does not exist — only pattern
   candidates.
4. What readiness means relative to arrival verification (CR-HM-07)
   needs frozen wording (readiness ≠ arrival, already firewall-fixed).

## 9. FM_FIREWALL

Scheduling ≠ work session; scheduling ≠ attendance; permit ≠ FM
maintenance/permit-to-work workflow; unit access ≠ arrival/location
verification and ≠ QR check-in; no quotation implementation; no
assignment implementation; no CR-HM-06 implementation.

## 10. RECOMMENDED_PARTS (advisory, pending decision)

1. PART 01 — Handyman scheduling rules/lifecycle + readiness
   CONTRACT surface (targetType-bindable; NO target binding).
2. PART 02 — bounded permit-readiness seam (tenant/unit service
   access only).
3. PART 03 — unit-access readiness (window + approval seam over
   existing authorities).
4. PART 04 — target-binding boundary doc (mirror of CR-HM-04 PART 04:
   contract shape frozen, binding deferred to CR-HM-06 authority).
5. PART 05A/05B — HTTP/OpenAPI + certification (CR-HM-03/04
   convention).

## 11. EXPLICIT ANSWERS

**Q1 — Can CR-HM-05 scheduling runtime be implemented before CR-HM-06
without inventing an execution target?**
**NO.** A target-bound scheduling runtime cannot exist before CR-HM-06
without inventing the execution target the frozen roadmap assigns to
CR-HM-06. Only the roadmap-documented rules/lifecycle/readiness layer
is implementable target-free, and only if target binding is deferred
by explicit contract (CR-HM-04 PART 04 pattern).

**Q2 — What exact existing authority owns building/floor/unit/space?**
The existing masters: `buildings` / `floors` / `areas` / `rooms`
(unit) / `spaces`; tenant access context via
`tenant_building_contexts` (+ tenant-space relationships); Handyman
handles = the immutable CR-HM-01 attribution and CR-HM-02 request
snapshots (`buildingId`, `spaceId`). No duplicate authority will be
created.

**Q3 — Is the existing permit runtime suitable for Handyman unit
access, or only reusable as pattern/infrastructure?**
**Only as pattern/infrastructure.** BE-20 is FM Permit-to-Work; its
lifecycle/workflow is not tenant/unit service access. The Handyman
permit surface is NEW and bounded; engine semantics (context
indirection, validity, approvals) may be reused as patterns or
integration seams, never as adopted FM workflow.

**Q4 — What must remain deferred to CR-HM-07 Arrival & Location
Verification?**
Verified-arrival determination itself: QR/challenge issuance and
proof, expected building/floor/unit validation, geofence/risk
signals, and any gate whose outcome is "arrival verified". CR-HM-05
may only produce readiness facts (scheduled window, permit ready,
access approved); readiness NEVER equals verified arrival, and
presence/session semantics remain CR-HM-08 territory.

**Q5 — Does frozen roadmap dependency ordering require a governance
resolution before CR-HM-05 coding?**
**YES.** Because Q1=NO, the owner must resolve ONE of:
(a) confirm the roadmap-documented containment decomposition as
CR-HM-05's implementation shape — rules/lifecycle/readiness coded,
target-binding frozen-and-deferred exactly mirroring CR-HM-04 PART 04
(roadmap unchanged); or
(b) resequence CR-HM-05 after CR-HM-06 by explicit governance change.
This governance does NOT change the roadmap; it records the conflict
and awaits the decision.

---

**STATUS: BLOCKED_FOR_DECISION** (Q1=NO). No CR-HM-05 runtime coding
until the decision (a) or (b) is recorded.
