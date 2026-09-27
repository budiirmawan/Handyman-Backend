# CR-HM-00 — Cross-Repository Ownership & Dependency Matrix

Status: GOVERNANCE ARTIFACT ONLY
Runtime implementation: NO
Coding roadmap: NOT IN SCOPE

This document records the cross-repository implementation
ownership/dependency matrix derived from the already-FROZEN
CR-HM-00 mapping results. It assigns implementation ownership
and dependency direction only. It defines no endpoints, schemas,
event names, entitlement keys, product/package IDs, or runtime
enums, and it does not sequence implementation work.

## Frozen Inputs (authoritative, supplied)

- Handyman-Backend: FROZEN; 37/37 capability coverage; GAP 0;
  business/API/operational/transaction authority for Handyman.
- Handyman-Frontend: FROZEN; 223 canonical mappings; journey
  20/20 COVERED; GAP 0; presentation/orchestration client;
  NEW/EXTEND runtime binding depends on authoritative
  Handyman-Backend contracts.
- Mob-Handyman: FROZEN; 67 canonical mappings (18 REUSE,
  25 REUSE_WITH_CONTEXT, 18 EXTEND, 6 NEW); field journey
  18/18 COVERED; GAP 0; field presentation/execution client;
  no business/commercial authority.
- Asentra-SaaS: FROZEN; 22 canonical mappings (7 REUSE,
  5 REUSE_WITH_CONTEXT, 6 EXTEND, 4 NEW); lifecycle 10/10
  COVERED; GAP 0; control/commercial plane; Handyman
  CONTRACT_NOT_BACKED at freeze; future integration requires an
  explicit authoritative Handyman-Backend contract.

Only these frozen facts are used. No other repository was
inspected, fetched, compared, or accessed.

## Ownership Summary

- Rows 1–26: Handyman operational/transaction domains.
  Authoritative owner: Handyman-Backend.
- Rows 27–30: SaaS product/subscription/entitlement/provisioning
  control-plane state. Authoritative owner: Asentra-SaaS.
- Rows 31–34: cross-system integration seams with explicit
  split ownership, detailed per row.

Frontend and Mobile are consumers/execution clients only in every
row; no authoritative business/commercial rule is assigned to
either client in any row.

## Matrix

| Capability / Integration Seam | Authoritative Owner | Backend Requirement | Frontend Consumer | Mobile Consumer | SaaS Consumer | Dependency / Contract Rule |
|---|---|---|---|---|---|---|
| 1. Secure BM Super App Handoff | Handyman-Backend | Own trusted customer/building/unit identity acceptance and Handyman session/context establishment; backend authorization remains authoritative (NEW). | Receives the backend-established session/context and orchestrates entry presentation; makes no identity or authorization decision. | Derives field session context from backend-established context only; makes no identity or authorization decision. | — (no role at freeze) | Handyman-Backend handoff/context authority → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring. Client-initiated context is never authoritative; never reversed. |
| 2. Channel Attribution | Handyman-Backend | Own immutable channel attribution from request through the transaction lifecycle; never silently overwritten or inferred later (NEW). | Presents attribution exactly as recorded by the backend; cannot set or modify it. | Presents attribution exactly as recorded by the backend; field capture passes through backend authority. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring. Attribution mutation is backend-only; never reversed. |
| 3. Handyman Service Request | Handyman-Backend | Own the Handyman customer request lifecycle and states, extending existing request capability (EXTEND). | Request intake/status presentation and journey orchestration; holds no local lifecycle rules. | Field visibility of assigned request context; holds no lifecycle authority. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 4. Triage / Inspection / Diagnosis | Handyman-Backend | Own the decision sequence Request → Initial Triage → Inspection when required → Diagnosis → Scope Classification, including in-scope determination (NEW). | Presents triage/diagnosis outcomes as decided by the backend; performs no decision logic. | Field capture supporting inspection and diagnosis as execution client; decisions are recorded by the backend. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 5. Specialist Escalation | Handyman-Backend | Own the referral decision and target specialist/service category record while preserving original request/history (NEW). | Presents referral/escalation state; decides nothing client-side. | Presents referral state to the field worker; decides nothing client-side. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; referral must not silently become an FM workflow; never reversed. |
| 6. Service Catalogue | Handyman-Backend | Own Handyman services/variants and the future material discovery model including reference price and exclusion scope (EXTEND). | Catalogue browsing and selection presentation; no catalogue authority. | Catalogue reference for field execution where required; no catalogue authority. | — (SaaS product/package exposure is a separate control plane; see rows 27–30) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; catalogue/reference price is not the final transaction charge; never reversed. |
| 7. Scheduling / Rescheduling | Handyman-Backend | Own Handyman scheduling rules and lifecycle over reused scheduling capability (REUSE_WITH_CONTEXT). | Schedule and rescheduling presentation/orchestration; no scheduling rules client-side. | Field schedule/visit presentation and execution; no scheduling rules client-side. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 8. Quotation | Handyman-Backend | Own immutable, versioned quotations with governed charge lines, price snapshot, expiry, and revisions (NEW). | Presents the exact quotation version to the customer; cannot compose or alter pricing. | Read-only field visibility of quotation/scope context where required; never a quotation or pricing authority. | — (SaaS Package Price != Handyman quotation/final charge) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; quotation snapshots are immutable; later catalogue changes do not alter them; never reversed. |
| 9. Customer Quotation Approval | Handyman-Backend | Own auditable customer APPROVE / REJECT / policy-permitted revision request bound to the exact quotation version (NEW). | Customer decision presentation and capture; the backend records and owns the decision. | — (customer decision is not a field execution concern at freeze) | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; Quotation Approval != BAST Acceptance and != Payment Confirmation; never reversed. |
| 10. Provider / Worker / Crew | Handyman-Backend | Own provider relationships in Handyman context, workforce reuse with boundaries, and Handyman Work Crew composition/assignment/replacement/history (REUSE_WITH_CONTEXT + NEW). | Provider/worker/crew presentation where journeys require it; no lifecycle authority. | Field identity and crew execution context including helper handling per backend rules; no lifecycle authority. | — (SaaS Vendor Administration != Handyman Provider operational lifecycle) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 11. Permit / Unit Access | Handyman-Backend | Own Handyman permit applicability, rules, and lifecycle, plus unit access context boundaries (REUSE_WITH_CONTEXT). | Permit/access status presentation; no applicability decision client-side. | Field permit/access status presentation for execution; no applicability decision client-side. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 12. Arrival & Location Verification | Handyman-Backend | Own the arrival verification sequence, methods, geofence/risk signals, and confidence/risk result; shared attendance/location/access engines are infrastructure only (NEW). | Presents backend-derived arrival/verification state; performs no verification decision. | Field execution client for Lead Worker verification capture under backend challenge/rules; the result is decided and recorded by the backend. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; Arrival Verification != CHECK-IN; never reversed. |
| 13. Work Session | Handyman-Backend | Own session events (CHECK-IN, START WORK, PAUSE, RESUME, MATERIAL RUN, COMPLETE, CHECK-OUT) and separate presence, work, and billable time (NEW). | Presents backend-owned session/progress state; no session rules or time computation client-side. | Field execution client for session event capture; session semantics and time separation are backend-owned. | — (Generic attendance != Handyman Work Session) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; Presence Time != Actual Work Time != Billable Time; CHECK-IN != START WORK; never reversed. |
| 14. Evidence | Handyman-Backend | Own Handyman evidence stages/types and lifecycle over extended evidence capability (EXTEND). | Presents evidence to the customer as recorded; no evidence authority. | Field evidence capture client (BEFORE/DURING/AFTER/QC/DEFECT/RECTIFICATION/MATERIAL/BAST/WARRANTY); acceptance and lifecycle remain backend-owned. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 15. Material Execution | Handyman-Backend | Own the Handyman material lifecycle Estimated → Approved → Issued/Purchased → Used → Returned → Final Usage and its reconciliation (EXTEND). | Material option/cost visibility and approval surfaces as orchestration client; no material state authority. | Field execution client for issue/use/return capture; material state and usage records are backend-owned. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; material usage != authoritative final material charge; never reversed. |
| 16. QC / Checklist | Handyman-Backend | Own Handyman QC templates, criteria, and execution outcomes over reused checklist capability (REUSE). | QC outcome presentation; no checklist authority. | Field QC execution/capture client; template and result authority remain backend-owned. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 17. Defect / Rectification / Reinspection | Handyman-Backend | Own Handyman-scoped defect, rectification, and reinspection lifecycle over reused finding/rework capability (REUSE). | Defect/rectification status presentation; no lifecycle authority. | Field rectification and reinspection execution/capture; lifecycle decisions remain backend-owned. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 18. BAST / Customer Acceptance | Handyman-Backend | Own Handyman structured digital service acceptance over extended shared BAST capability (EXTEND). | Customer acceptance presentation and capture; the backend records and owns the acceptance. | Field facilitation/capture of acceptance at site; the backend remains authoritative for the record. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; Quotation Approval != BAST Acceptance; never reversed. |
| 19. SLA / Provider Performance | Handyman-Backend | Own Handyman SLA definitions/bindings/milestone events over extended shared SLA infrastructure, and the derived provider performance read model (EXTEND). | SLA and provider performance presentation as backend-derived state; no KPI entry client-side. | Field visibility of applicable SLA state where required; no SLA authority. | — (no role at freeze) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; SLA Engine != Provider Performance Read Model; performance is derived, not manually entered; never reversed. |
| 20. Customer Transaction / Payment | Handyman-Backend | Own the Handyman Customer Transaction Ledger: customer charge lines, payment allocation, refund, reversal, adjustment, and immutable financial history (NEW). | Payment presentation/orchestration for the customer; every financial effect is executed and recorded by the backend. | — (no business/commercial authority at freeze) | — (SaaS Billing != Handyman Customer Transaction Ledger) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 21. Commercial Agreement / BM Fee | Handyman-Backend | Own versioned commercial agreements and configurable fee basis, with the LABOR_ONLY default/reference model (NEW). | Read-model presentation of backend-governed commercial outcomes where required; no rule evaluation client-side. | — (no business/commercial authority at freeze) | — (no transaction calculation inside SaaS subscription logic) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 22. Provider & BM Financial Entitlement | Handyman-Backend | Own derivation of provider earning and BM fee earning from governed Handyman transaction and commercial rules (NEW). | — (backend-internal financial domain at freeze) | — (no business/commercial authority at freeze) | — (SaaS Product Entitlement != Provider/BM Financial Entitlement) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring where any future presentation exists; never reversed. |
| 23. Settlement / Reconciliation | Handyman-Backend | Own settlement states EARNED, PAYABLE, INCLUDED_IN_SETTLEMENT, SETTLED and REVERSED / ADJUSTED / DISPUTED exceptions (NEW). | — (backend-internal financial domain at freeze) | — (no business/commercial authority at freeze) | — (settlement must not be inferred from SaaS billing or subscription state) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring where any future presentation exists; never reversed. |
| 24. Service Warranty / Claim / Rework | Handyman-Backend | Own workmanship warranty, material warranty, warranty claims, free warranty rework, and chargeable additional work (NEW). | Warranty claim intake/status presentation for the customer; no warranty authority. | Field execution/capture of warranty rework; warranty decisions remain backend-owned. | — (Asset Warranty != Handyman Service Warranty) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 25. Notification / Communication | Handyman-Backend | Own Handyman event meaning, recipients, and templates over reused notification/delivery capability (REUSE). | Receives and presents notifications; defines no event meaning. | Receives and presents field notifications; defines no event meaning. | — (SaaS control-plane notifications, if any, are separate SaaS concern) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; never reversed. |
| 26. Audit / Security / Reliability | Handyman-Backend | Own Handyman audit context, authorization boundaries, tenant/data isolation, and reliability of Handyman runtime (REUSE + boundaries). | Subject to backend authorization and audit; no security or audit authority. | Subject to backend authorization and audit; no security or audit authority. | — (SaaS keeps its own control-plane audit; it does not own Handyman runtime audit) | Handyman-Backend domain/runtime → authoritative API/OpenAPI contract → client adapter/integration → UI/execution wiring; clients are never authoritative for security/audit decisions; never reversed. |
| 27. SaaS Product / Package Exposure | Asentra-SaaS | Handyman commits no runtime exposure from SaaS packaging; any Handyman capability exposed through SaaS requires an explicit authoritative Handyman-Backend contract first (CONTRACT_NOT_BACKED at freeze). | — (SaaS packaging presentation belongs to the SaaS plane; the Handyman frontend consumes nothing here at freeze) | — | Owns and presents SaaS product/package control-plane state. | SaaS control-plane capability → explicit SaaS ↔ Handyman integration contract where needed → Handyman-side acceptance/acknowledgement → SaaS state presentation; SaaS Package Price != Handyman quotation/final charge; never reversed. |
| 28. SaaS Subscription Association | Asentra-SaaS | Handyman runtime behavior must not be inferred from subscription state; any Handyman-side effect requires an explicit authoritative Handyman-Backend contract and Handyman-side acceptance (CONTRACT_NOT_BACKED at freeze). | — | — | Owns SaaS subscription association state for the control plane. | SaaS control-plane capability → explicit SaaS ↔ Handyman integration contract where needed → Handyman-side acceptance/acknowledgement (gated by row 31) → SaaS state presentation; subscription state must not directly gate Handyman runtime; never reversed. |
| 29. SaaS Entitlement | Asentra-SaaS | Handyman must not treat SaaS product entitlement as provider/BM financial entitlement, nor derive operational behavior from it without an explicit authoritative contract and Handyman-side acceptance state. | — | — | Owns SaaS product entitlement state for the control plane. | SaaS control-plane capability → explicit SaaS ↔ Handyman integration contract where needed → Handyman-side acceptance/acknowledgement → SaaS state presentation; SaaS Product Entitlement != Provider/BM Financial Entitlement; never reversed. |
| 30. SaaS Customer / Building Provisioning | Asentra-SaaS | Handyman-side customer/building context establishment remains Handyman-Backend authority; SaaS provisioning takes effect on the Handyman side only through an explicit authoritative contract and Handyman-side acknowledgement (row 32). | — | — | Owns control-plane provisioning request/state and presents Handyman-side acknowledgement received via contract. | SaaS control-plane capability → explicit SaaS ↔ Handyman integration contract → Handyman-side acceptance/acknowledgement → SaaS state presentation; never reversed. |
| 31. Handyman Capability Activation | Asentra-SaaS owns activation orchestration/control-plane request state; Handyman-Backend owns Handyman-side activation acceptance/state | Own Handyman-side activation acceptance/state and expose it only through an authoritative Handyman-Backend contract. | — (no client authority over activation) | — (no client authority over activation) | Owns activation request orchestration state and consumes Handyman-side acceptance state only via contract. | SaaS activation orchestration → explicit SaaS ↔ Handyman integration contract → Handyman-Backend-owned acceptance/state → SaaS state presentation; neither side may assert the other's activation state; never reversed. |
| 32. Provisioning Acknowledgement | Handyman-Backend is authoritative for Handyman-side acknowledgement; Asentra-SaaS may record/display acknowledgement | Own the authoritative Handyman-side provisioning acknowledgement record and its contract surface. | — | — | May record and display acknowledgement as received via contract; is not authoritative for the Handyman-side record. | Handyman-side acknowledgement authority → authoritative API/OpenAPI contract → SaaS adapter/integration → SaaS presentation; SaaS must not declare Handyman acknowledgement unilaterally; never reversed. |
| 33. Provider Marketplace Enablement | Asentra-SaaS owns commercial enablement; Handyman-Backend owns provider onboarding, eligibility, operational assignment, and transaction lifecycle | Own the provider operational lifecycle; SaaS commercial enablement reaches Handyman operations only through an explicit authoritative contract with Handyman-side acceptance. | — (provider presentation, where it exists, renders backend-owned state only) | — (no provider lifecycle authority) | Owns commercial enablement state and presents Handyman-side operational state only as received via contract. | SaaS commercial enablement → explicit SaaS ↔ Handyman integration contract → Handyman-Backend-owned operational acceptance/application → SaaS state presentation; SaaS Vendor Administration != Handyman Provider operational lifecycle; never reversed. |
| 34. SaaS Integration Status / Health | Asentra-SaaS for integration/control-plane observation only; Handyman-Backend remains authority for Handyman operational status | Own Handyman operational status truth; integration health consumers receive backend-exposed state only through the authoritative contract. | — | — | Observes and presents integration status/health for its control plane; must not become Handyman operational status authority. | Observation only: Handyman-Backend contract state → explicit SaaS ↔ Handyman integration contract → SaaS observation/presentation; never authoritative for Handyman operational status; never reversed. |

## Domain Firewall (preserved explicitly)

- SaaS Billing != Handyman Customer Transaction Ledger
- SaaS Product Entitlement != Provider/BM Financial Entitlement
- SaaS Package Price != Handyman quotation/final charge
- SaaS Vendor Administration != Handyman Provider operational lifecycle
- Generic task/WO != Handyman Work Session
- Generic attendance != Handyman Work Session
- Arrival Verification != CHECK-IN
- CHECK-IN != START WORK
- Quotation Approval != BAST Acceptance
- Asset Warranty != Handyman Service Warranty
- Presence Time != Actual Work Time != Billable Time
- Material usage != authoritative final material charge

## Dependency Direction (binding)

For every Handyman runtime capability consumed by another
repository:

Handyman-Backend domain/runtime
→ authoritative API/OpenAPI contract
→ client adapter/integration
→ UI/execution wiring

For every SaaS-owned control-plane capability that touches
Handyman:

SaaS control-plane capability
→ explicit SaaS ↔ Handyman integration contract where needed
→ Handyman-side acceptance/acknowledgement
→ SaaS state presentation

Dependency direction must never be reversed in either chain.

## Validation Record

- Matrix rows: exactly 34 (numbered 1–34 above).
- Every row has an explicit authoritative owner.
- Rows 31–34 preserve split ownership exactly as specified
  (31: activation, 32: provisioning acknowledgement,
  33: provider marketplace enablement, 34: integration
  status/health).
- Frontend and Mobile are consumers/execution clients in every
  row; no business/commercial authority is assigned to either.
- Dependency direction is explicit in every row and never
  reversed.
- Authority conflicts: 0 (split scopes are complementary and
  non-overlapping).
- Transaction/control-plane firewall preserved (see Domain
  Firewall).
- No endpoints, schemas, event names, entitlement keys,
  product/package IDs, or runtime enums are invented here.
- Frozen source maps (backend capability map and the supplied
  frozen cross-repo facts) are unchanged by this artifact.
- Runtime changes: 0.
