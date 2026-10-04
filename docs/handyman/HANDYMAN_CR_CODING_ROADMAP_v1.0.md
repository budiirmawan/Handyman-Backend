# HANDYMAN CR CODING ROADMAP — v1.0

Status: FROZEN
Roadmap Version: 1.0
Artifact type: authoritative cross-repository CR coding roadmap
(governance only; no runtime implementation; no endpoints, schemas,
DB tables, events, or runtime enums are defined here — those belong
to each implementation CR).

Additive amendment index: HANDYMAN ROADMAP AMENDMENT 01 — Persona &
Frontend is registered in the appendix below. It preserves the frozen
v1.0 base definitions and CR-HM-01..22 numbering.

Derived exclusively from:

- `docs/handyman/CR-HM-00_BACKEND_CAPABILITY_MAP.md`
  (FROZEN; 37/37 coverage; GAP 0)
- `docs/handyman/CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md`
  (34 ownership rows; dependency classification A26 / B3 / C5;
  dependency cycle count 0)

## Roadmap Principle

Order CRs by dependency, not by matrix row number.

For Handyman runtime consumed by clients:

Handyman-Backend runtime/domain
→ authoritative API/OpenAPI contract
→ Frontend/Mobile integration
→ UI/execution wiring

For SaaS integration:

SaaS control plane
→ explicit SaaS ↔ Handyman contract
→ Handyman acceptance/acknowledgement
→ SaaS presentation/state

No frontend/mobile runtime CR may be created before the backend
contract CR it requires. No SaaS integration CR may assert
Handyman-side state without the explicit cross-system contract.

## CR Definitions

### CR-HM-01 — Channel Context & Secure Handoff

Scope:

- Secure BM Super App Handoff
- immutable Channel Attribution
- customer/building/channel context

Primary authority: Handyman-Backend

### CR-HM-02 — Service Catalogue & Request Intake

Scope:

- Handyman Service Catalogue
- service/variant/common-material reference exposure
- Handyman Service Request
- photo/video/evidence intake seam

Primary authority: Handyman-Backend

### CR-HM-03 — Triage, Inspection & Specialist Escalation

Scope:

- triage
- inspection
- diagnosis
- specialist escalation/referral
- preserve original request/history

Primary authority: Handyman-Backend

Handyman diagnosis may refer/escalate excluded cases only; FM
workflows are never absorbed.

### CR-HM-04 — Provider, Worker & Crew

Scope:

- provider operational context
- worker
- Lead Worker/PIC
- crew/helper confirmation
- crew assignment

Primary authority: Handyman-Backend

### CR-HM-05 — Scheduling, Permit & Unit Access

Scope:

- scheduling/rescheduling
- permit/unit access readiness
- building access constraints

Primary authority: Handyman-Backend

### CR-HM-06 — Quotation & Customer Approval

Scope:

- quotation
- labor/material separation
- scope snapshot
- customer quotation approval

Primary authority: Handyman-Backend

Preserve: SaaS Package Price != Handyman quotation/final charge;
Quotation Approval != Payment Confirmation.

### CR-HM-07 — Arrival & Location Verification

Scope:

- arrival verification
- QR challenge
- expected building/floor/unit
- server challenge/timestamp
- geofence/risk signals

Primary authority: Handyman-Backend

Preserve:

- QR != proof
- Permit/access != verified arrival
- Arrival Verification != CHECK-IN

### CR-HM-08 — Work Session & Field Execution

Scope:

- CHECK-IN
- START WORK
- PAUSE
- RESUME
- MATERIAL RUN
- COMPLETE
- CHECK-OUT
- presence/work/billable-time separation

Primary authority: Handyman-Backend

Preserve: Presence Time != Actual Work Time != Billable Time;
CHECK-IN != START WORK; Generic attendance != Handyman Work
Session; Generic task/WO != Handyman Work Session.

### CR-HM-09 — Material Execution

Scope:

- Estimated
- Approved
- Issued/Purchased
- Used
- Returned
- final usage basis

Primary authority: Handyman-Backend

Final material charge remains financial-domain authority
(material usage != authoritative final material charge).

### CR-HM-10 — Evidence, QC & Rectification

Scope:

- staged evidence
- dynamic checklist/QC
- PASS/DEFECT/N/A/NOT CHECKED
- defect
- rectification
- reinspection

Primary authority: Handyman-Backend

### CR-HM-11 — BAST & Customer Acceptance

Scope:

- structured digital BAST
- acceptance evidence/signature
- customer acceptance state

Primary authority: Handyman-Backend

Preserve:

- COMPLETE != BAST Acceptance
- Quotation Approval != BAST Acceptance

### CR-HM-12 — Pricing & Commercial Agreement

Scope:

- labor pricing modes
- crew pricing modes
- material pricing basis
- commercial agreement
- BM fee rules/basis

Primary authority: Handyman-Backend

Preserve: catalogue/reference price is an input only, never the
final transaction charge; no transaction calculation inside SaaS
subscription logic.

### CR-HM-13 — Customer Transaction & Payment Ledger

Scope:

- Customer Transaction
- Charge Line
- Payment
- Allocation
- Refund
- Reversal
- Adjustment

Primary authority: Handyman-Backend

Preserve: SaaS Billing != Handyman Customer Transaction Ledger.

### CR-HM-14 — Financial Entitlement & Settlement

Scope:

- Provider Entitlement
- BM Fee Entitlement
- settlement
- reconciliation

Primary authority: Handyman-Backend

Depends on: CR-HM-12, CR-HM-13

Preserve: SaaS Product Entitlement != Provider/BM Financial
Entitlement; settlement is never inferred from SaaS billing or
subscription state.

### CR-HM-15 — Service Warranty, Claim & Rework

Scope:

- workmanship warranty
- material warranty
- warranty start after accepted BAST
- claim
- eligibility
- free warranty rework
- chargeable additional work separation

Primary authority: Handyman-Backend

Preserve: Asset Warranty != Handyman Service Warranty.

### CR-HM-16 — SLA, Notification, Audit & Reliability

Scope:

- SLA/provider performance
- notification/communication
- audit/security/privacy
- outbox/webhook/integration reliability

Primary authority: Handyman-Backend

Preserve: SLA Engine != Provider Performance Read Model; provider
performance is derived from governed operational events, not
manually entered KPI values.

### CR-HM-17 — Frontend Handyman Journey Integration

Repository: Handyman-Frontend

Scope: Bind frozen frontend journey to authoritative
Handyman-Backend contracts delivered by CR-HM-01..16 as
applicable.

Frontend remains presentation/orchestration client.

Do NOT duplicate backend business rules.

### CR-HM-18 — Mobile Field Journey Integration

Repository: Mob-Handyman

Scope: Bind frozen mobile field journey to authoritative
Handyman-Backend contracts delivered by CR-HM-01..16 as
applicable.

Mobile remains field presentation/execution client.

Preserve offline command/idempotency semantics.

### CR-HM-19 — SaaS Handyman Product & Entitlement Exposure

Repository: Asentra-SaaS

Scope:

- HANDYMAN product exposure
- package/commercial offering exposure
- subscription association
- entitlement exposure
- customer/building provisioning exposure
- SaaS commercial visibility

SaaS remains control/commercial plane.

Do NOT implement Handyman transaction ledger in SaaS.

### CR-HM-20 — SaaS ↔ Handyman Activation Integration

Cross-system: Asentra-SaaS + Handyman-Backend

Scope:

- capability activation orchestration
- provisioning acknowledgement
- idempotency/correlation contract
- activated-state visibility

Preserve: Entitled != Provisioned != Activated; Handyman-Backend
owns Handyman-side activation acceptance/state and the
authoritative provisioning acknowledgement.

### CR-HM-21 — Provider Marketplace Enablement Integration

Cross-system: Asentra-SaaS + Handyman-Backend

Scope:

- SaaS marketplace commercial enablement
- Handyman-side provider operational acceptance
- integration boundary only

Preserve:

- Marketplace Enabled != Provider Approved
- SaaS Vendor Administration != Handyman Provider operational
  lifecycle

### CR-HM-22 — Integration Status & Release Certification

Cross-repository

Scope:

- SaaS ↔ Handyman integration health
- contract parity
- end-to-end journey certification
- authority/firewall verification
- release readiness

Integration health must not become Handyman service operational
status.

## Roadmap Table

| CR | Name | Primary Repository | Depends On | Produces Contract For | Runtime Authority | Exit Gate |
|---|---|---|---|---|---|---|
| CR-HM-01 | Channel Context & Secure Handoff | Handyman-Backend | — | CR-HM-02, CR-HM-17, CR-HM-18 | Handyman-Backend | Authoritative handoff/context and attribution contracts published; backend authorization remains sole authority; no client-side identity/trust decision possible by contract review. |
| CR-HM-02 | Service Catalogue & Request Intake | Handyman-Backend | CR-HM-01 | CR-HM-03, CR-HM-06, CR-HM-17, CR-HM-18 | Handyman-Backend | Catalogue and request-lifecycle contracts published, bound to handoff context with immutable attribution carried from intake; evidence intake seam delivered as bounded interface (full evidence lifecycle authority closes in CR-HM-10); exclusion scope enforced by contract scope. |
| CR-HM-03 | Triage, Inspection & Specialist Escalation | Handyman-Backend | CR-HM-02 | CR-HM-06, CR-HM-17, CR-HM-18 | Handyman-Backend | Triage/inspection/diagnosis/escalation decision contracts published; original request/history preserved; referral cannot convert into FM workflow or silently expand scope. |
| CR-HM-04 | Provider, Worker & Crew | Handyman-Backend | — | CR-HM-07, CR-HM-18, CR-HM-21 | Handyman-Backend | Provider context, Lead Worker/PIC, crew/helper, and assignment contracts published; crew lifecycle authority verified as backend-only; boundary to SaaS vendor administration stated in contract scope. |
| CR-HM-05 | Scheduling, Permit & Unit Access | Handyman-Backend | — | CR-HM-07, CR-HM-17, CR-HM-18 | Handyman-Backend | Scheduling/rescheduling and permit/access-readiness contracts published; permit/access != verified arrival preserved; authorized-scope scheduling binding closes when CR-HM-06 lands (see derivation notes). |
| CR-HM-06 | Quotation & Customer Approval | Handyman-Backend | CR-HM-02, CR-HM-03 | CR-HM-05, CR-HM-07, CR-HM-09, CR-HM-13, CR-HM-17 | Handyman-Backend | Immutable versioned quotation and version-bound approval contracts published; labor/material separation and scope snapshot enforced; approval creates authorized execution scope; SaaS package price firewall verified. |
| CR-HM-07 | Arrival & Location Verification | Handyman-Backend | CR-HM-04, CR-HM-05, CR-HM-06 | CR-HM-08, CR-HM-18 | Handyman-Backend | Verification contract (challenge, expected location, risk/confidence) published against approved/scheduled/assigned work; QR != proof and Arrival Verification != CHECK-IN verified. |
| CR-HM-08 | Work Session & Field Execution | Handyman-Backend | CR-HM-07 | CR-HM-11, CR-HM-13, CR-HM-18 | Handyman-Backend | Session-event contract with presence/work/billable separation published; CHECK-IN != START WORK verified; offline/idempotent capture semantics preserved for the mobile client. |
| CR-HM-09 | Material Execution | Handyman-Backend | CR-HM-06 | CR-HM-13, CR-HM-18 | Handyman-Backend | Material lifecycle contract (Estimated → Approved → Issued/Purchased → Used → Returned → final usage) published; final charge authority stays financial-domain; usage != final charge verified. |
| CR-HM-10 | Evidence, QC & Rectification | Handyman-Backend | — | CR-HM-02, CR-HM-17, CR-HM-18 | Handyman-Backend | Staged evidence, QC checklist outcomes, defect/rectification/reinspection contracts published; evidence intake seam binding for CR-HM-02 closed; Handyman QC templates remain separate from FM checklists. |
| CR-HM-11 | BAST & Customer Acceptance | Handyman-Backend | CR-HM-08 | CR-HM-15, CR-HM-17, CR-HM-18 | Handyman-Backend | Structured BAST and customer acceptance contracts published; COMPLETE != BAST Acceptance and Quotation Approval != BAST Acceptance verified. |
| CR-HM-12 | Pricing & Commercial Agreement | Handyman-Backend | — | CR-HM-06, CR-HM-14, CR-HM-17 | Handyman-Backend | Pricing-mode execution, commercial agreement versioning, and BM fee rule contracts published; reference price never final charge; no transaction calculation inside SaaS subscription logic. |
| CR-HM-13 | Customer Transaction & Payment Ledger | Handyman-Backend | CR-HM-06, CR-HM-08, CR-HM-09 | CR-HM-14, CR-HM-17 | Handyman-Backend | Transaction/charge-line/payment/allocation/refund/reversal/adjustment contracts published with immutable financial history; SaaS Billing firewall verified. |
| CR-HM-14 | Financial Entitlement & Settlement | Handyman-Backend | CR-HM-12, CR-HM-13 | CR-HM-17, CR-HM-22 | Handyman-Backend | Entitlement derivation and settlement/reconciliation contracts published; derivation traces only to governed transaction/commercial inputs; SaaS entitlement firewall verified. |
| CR-HM-15 | Service Warranty, Claim & Rework | Handyman-Backend | CR-HM-11 | CR-HM-17, CR-HM-18 | Handyman-Backend | Warranty/claim/rework contracts published with acceptance-based start eligibility; chargeable additional work separated; Asset Warranty firewall verified. |
| CR-HM-16 | SLA, Notification, Audit & Reliability | Handyman-Backend | — | CR-HM-17, CR-HM-18, CR-HM-22 | Handyman-Backend | Handyman SLA/notification/audit and integration-reliability contracts published; provider performance derivation model stated; boundaries to all consuming journeys verified. |
| CR-HM-17 | Frontend Handyman Journey Integration | Handyman-Frontend | CR-HM-01..16 (journey-slice-gated) | CR-HM-22 | Handyman-Backend (client is presentation/orchestration only) | Frozen frontend journey bound only to published backend contracts; zero backend business rules duplicated client-side; journey parity review passed. |
| CR-HM-18 | Mobile Field Journey Integration | Mob-Handyman | CR-HM-01..16 (journey-slice-gated) | CR-HM-22 | Handyman-Backend (client is field presentation/execution only) | Frozen field journey bound only to published backend contracts; offline command/idempotency semantics verified; no business/commercial authority client-side. |
| CR-HM-19 | SaaS Handyman Product & Entitlement Exposure | Asentra-SaaS | — | CR-HM-20, CR-HM-22 | Asentra-SaaS (control/commercial plane only) | Product/package/subscription/entitlement/provisioning exposure published in the SaaS plane; zero Handyman runtime inferred; no Handyman transaction logic present in SaaS. |
| CR-HM-20 | SaaS ↔ Handyman Activation Integration | Asentra-SaaS + Handyman-Backend | CR-HM-19 | CR-HM-21, CR-HM-22 | Split: Asentra-SaaS orchestration; Handyman-Backend acceptance/acknowledgement state | Explicit activation/provisioning-acknowledgement contract published with idempotency/correlation; Entitled != Provisioned != Activated verified; neither side asserts the other's state. |
| CR-HM-21 | Provider Marketplace Enablement Integration | Asentra-SaaS + Handyman-Backend | CR-HM-04, CR-HM-20 | CR-HM-22 | Split: Asentra-SaaS commercial enablement; Handyman-Backend provider operational lifecycle | Marketplace integration boundary published; Marketplace Enabled != Provider Approved verified; no Handyman operational lifecycle rule owned or duplicated in SaaS. |
| CR-HM-22 | Integration Status & Release Certification | Cross-repository | CR-HM-17, CR-HM-18, CR-HM-19, CR-HM-20, CR-HM-21 | — (terminal certification) | None new; Handyman operational status remains Handyman-Backend | Integration health observed across explicit contracts; contract parity, end-to-end journey certification, authority/firewall verification, and release readiness concluded. |

## Dependency Derivation Notes

Dependencies are derived from the 34-row matrix dependency graph
(PART 05B). All roadmap dependencies point strictly backward.
Two graph edges are contained and closed as documented here
rather than as forward CR dependencies:

- Channel Attribution (row 2) is bound by the Service Request
  lifecycle (row 3) at runtime. The attribution authority is
  delivered with channel context in CR-HM-01; its
  request-lifecycle persistence binding is exercised and verified
  inside CR-HM-02, which itself depends on CR-HM-01. No forward
  CR dependency is created.
- Scheduling (row 7) binds to the authorized execution scope
  created by Customer Quotation Approval (row 9). CR-HM-05
  delivers scheduling rules/lifecycle and permit readiness;
  the authorized-scope scheduling binding closes when CR-HM-06
  lands, and the field execution CR (CR-HM-07) depends directly
  on CR-HM-06 so the transitive constraint is enforced in
  backward order.

Client CR rule: CR-HM-17 and CR-HM-18 are dependency-gated
integration CRs — a journey slice may begin only after the
backend contract CRs it requires exist. This roadmap order
remains the governance sequence unless changed by explicit CR;
it does not imply every backend CR must wait for CR-HM-16
before any client integration can technically start.

SaaS rule: CR-HM-19 establishes SaaS-side exposure; CR-HM-20
then establishes explicit activation integration; CR-HM-21
establishes provider marketplace integration; CR-HM-22 certifies
the final cross-repository integration.

## Matrix Domain Coverage (all 34 domains)

| Matrix Domain | Covering CR |
|---|---|
| 1. Secure BM Super App Handoff | CR-HM-01 |
| 2. Channel Attribution | CR-HM-01 |
| 3. Handyman Service Request | CR-HM-02 |
| 4. Triage / Inspection / Diagnosis | CR-HM-03 |
| 5. Specialist Escalation | CR-HM-03 |
| 6. Service Catalogue | CR-HM-02 |
| 7. Scheduling / Rescheduling | CR-HM-05 |
| 8. Quotation | CR-HM-06 |
| 9. Customer Quotation Approval | CR-HM-06 |
| 10. Provider / Worker / Crew | CR-HM-04 |
| 11. Permit / Unit Access | CR-HM-05 |
| 12. Arrival & Location Verification | CR-HM-07 |
| 13. Work Session | CR-HM-08 |
| 14. Evidence | CR-HM-10 (intake seam from CR-HM-02 closes here) |
| 15. Material Execution | CR-HM-09 |
| 16. QC / Checklist | CR-HM-10 |
| 17. Defect / Rectification / Reinspection | CR-HM-10 |
| 18. BAST / Customer Acceptance | CR-HM-11 |
| 19. SLA / Provider Performance | CR-HM-16 |
| 20. Customer Transaction / Payment | CR-HM-13 |
| 21. Commercial Agreement / BM Fee | CR-HM-12 |
| 22. Provider & BM Financial Entitlement | CR-HM-14 |
| 23. Settlement / Reconciliation | CR-HM-14 |
| 24. Service Warranty / Claim / Rework | CR-HM-15 |
| 25. Notification / Communication | CR-HM-16 |
| 26. Audit / Security / Reliability | CR-HM-16 |
| 27. SaaS Product / Package Exposure | CR-HM-19 |
| 28. SaaS Subscription Association | CR-HM-19 |
| 29. SaaS Entitlement | CR-HM-19 |
| 30. SaaS Customer / Building Provisioning | CR-HM-19 |
| 31. Handyman Capability Activation | CR-HM-20 |
| 32. Provisioning Acknowledgement | CR-HM-20 |
| 33. Provider Marketplace Enablement | CR-HM-21 |
| 34. SaaS Integration Status / Health | CR-HM-22 |

## Strict Firewall & Scope Guard

Carried forward unchanged from the frozen matrix:

- SaaS Billing != Handyman Customer Transaction Ledger
- SaaS Product Entitlement != Provider/BM Financial Entitlement
- SaaS Package Price != Handyman quotation/final charge
- SaaS Vendor Administration != Handyman Provider operational
  lifecycle
- Generic task/WO != Handyman Work Session
- Generic attendance != Handyman Work Session
- Arrival Verification != CHECK-IN
- CHECK-IN != START WORK
- Quotation Approval != BAST Acceptance
- Asset Warranty != Handyman Service Warranty
- Presence Time != Actual Work Time != Billable Time
- Material usage != authoritative final material charge

NO FM EXPANSION. This roadmap does not add: BMS, common-area FM
workflow, preventive FM maintenance, central HVAC, building
electrical distribution, pumps/main/riser, fire system,
lift/genset, or structural/common-area workflow. Handyman
diagnosis may refer/escalate such cases only.

## Validation Record

- Top-level CRs: exactly 22 (CR-HM-01 through CR-HM-22, each
  exactly once, in dependency order).
- All 34 matrix domains covered by at least one CR; orphan
  domains: 0.
- Authoritative ownership: backend domains 1–26 → Handyman-Backend
  CRs (CR-HM-01..16); SaaS control-plane → Asentra-SaaS
  (CR-HM-19); split seams → cross-system CRs (CR-HM-20, 21);
  observation/certification → CR-HM-22. No duplicated
  authoritative ownership.
- Dependencies: every Depends On entry points backward in
  roadmap order; forward dependencies: 0; dependency cycles: 0.
- Backend → contract → client direction preserved (CR-HM-17/18
  bind only to CR-HM-01..16 contracts).
- SaaS control plane / Handyman transaction firewall preserved;
  FM expansion: none.
- Endpoints, schemas, DB tables, events, runtime enums: none
  defined here.
- Runtime changes: 0.

## Freeze

Status: FROZEN
Roadmap Version: 1.0

Future changes — top-level CR addition/removal, renumbering,
scope repurposing, or dependency-direction change — require an
explicit roadmap change CR.

---

## Additive Amendment Register — Amendment 01 (Persona & Frontend)

**Status: FROZEN — additive overlay to the frozen v1.0 base.** This
register is the explicit roadmap change for Amendment 01. The v1.0
CR-HM-01..22 definitions, order, and validation record above remain
the frozen base and are not renumbered or rewritten here. The frozen
34-row CR-HM-00 ownership matrix is unchanged. Full persona, surface,
authority, mirror, and communication boundaries are recorded in
`docs/handyman/HANDYMAN_ROADMAP_AMENDMENT_01_PERSONA_FRONTEND.md`.

| Registration | Name | Primary Repository / Authority | Depends On | Produces Contract For | Authority / Boundary |
|---|---|---|---|---|---|
| CR-HM-17-A01 | Customer Care Browser Visual Mirror | Handyman-Frontend; Handyman-Backend remains business/auth authority | CR-HM-17 | CR-HM-22 | Production Customer Care journey and browser mirror update together per UX PART; mirror is non-authoritative and does not alter the BM Super App → Handyman-Frontend path. |
| CR-HM-23 | Operations Portal Authority & Integration | Handyman-Backend authority + Handyman-Operations consumer | CR-HM-04, CR-HM-18 | CR-HM-24, CR-HM-25 | Explicit Persona → Surface → Role → Capability → Backend chain; Admin and Dispatcher remain distinct; Backend is final authorization authority. |
| CR-HM-24 | Admin/Dispatcher Operations Frontend | Handyman-Operations | CR-HM-23; applicable published CR-HM-01..16/18 contracts | CR-HM-22, CR-HM-25 | Presents explicitly granted Admin/Dispatcher capabilities in one portal; UI and mirror do not own business or assignment authority. |
| CR-HM-25 | Job Conversation & Operational Communication | Handyman-Backend authority; Handyman-Frontend, Handyman-Operations, and Mob-Handyman consumers | CR-HM-04, CR-HM-06, CR-HM-16, CR-HM-23 | CR-HM-17, CR-HM-18, CR-HM-24 | Job/scope conversation is distinct from Notification/System Event; Backend is authoritative and each client is presentation only. |

CR-HM-17-A01 is subordinate to CR-HM-17 and is not a new top-level
number. CR-HM-23, CR-HM-24, and CR-HM-25 are additive top-level
registrations after CR-HM-22. This appendix does not redefine any
base dependency, surface implementation, endpoint, schema, or runtime
behavior.
