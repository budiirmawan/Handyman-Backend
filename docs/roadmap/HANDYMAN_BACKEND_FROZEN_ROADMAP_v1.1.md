# HANDYMAN APARTMENT — Journey Lifecycle Production Coding Roadmap v1.1

Status: FROZEN
Freeze date: 2026-09-10
Repository: Handyman-Backend

---

## GOVERNANCE

This roadmap is authoritative for Handyman Apartment production implementation.

Handyman is an extension/bounded context using the existing Asentra backend operational foundation.

Do not rebuild existing Asentra capabilities when they can be reused or extended.

After coding begins:

- do not renumber frozen waves;
- do not shift waves;
- do not merge waves;
- do not repurpose waves;
- do not insert new top-level waves;
- do not remove frozen waves.

Any top-level roadmap change requires an explicit Change Request (CR).

Internal PARTs may be split into smaller Arena Ultra-Light implementation units without changing the frozen wave scope.

Backend remains authoritative for:

- business rules;
- lifecycle/state transitions;
- pricing;
- commercial rules;
- payment/ledger facts;
- BM fee;
- settlement;
- QC completion;
- BAST;
- warranty;
- authorization.

---

## FROZEN BACKEND SEQUENCE

HC-00 — Governance, Domain Boundary & Reuse Map

HC-01 — Building Handyman & Channel Configuration

HC-02 — BM Super App Secure Handoff, Resident/Tenant/Building/Unit Context

HC-03 — Immutable Channel Attribution

HC-04 — Service Catalog/Discovery & Tenant Handyman Request

HC-05 — Initial Triage, Inspection Routing & Specialist Escalation

HC-06 — Inspection, Diagnosis & Scope Classification

HC-07 — Commercial Agreement, Fee-Rule Versioning & Commercial Snapshot Foundation

HC-08 — Pricing/Rate Execution Foundation

HC-09 — Quotation, Immutable Versioning & Expiry/Revision

HC-10 — Customer Decision, Cancellation/Reschedule Policy & Approval

HC-11 — Work Order Orchestration

HC-12 — Provider Dispatch, Accept/Decline, Reassignment & Escalation

HC-13 — Work Crew, Lead Worker, Helper & Crew Replacement

HC-14 — Schedule, Building Policy, Permit, Access & No-Show/Reschedule

HC-15 — Arrival & Location Verification

HC-16 — Crew Attendance & Work-Session Lifecycle

HC-17 — Material Request, Approval, Issue/Purchase, Usage, Return & Final Usage

HC-18 — Dynamic Handyman QC Checklist Binding

HC-19 — Evidence Capture Contract & Photo-Quality Gate

HC-20 — Defect/Finding, Rectification, Re-Inspection & Rework

HC-21 — QC Completion Gate

HC-22 — Digital BAST, Customer Acceptance & BAST Dispute

HC-23 — Final Charge Authority & Customer Transaction Ledger

HC-24 — Payment, Receipt, Failure, Refund, Reversal & Adjustment

HC-25 — Provider Entitlement & BM Fee Entitlement

HC-26 — Settlement & Reconciliation

HC-27 — Service Warranty Activation

HC-28 — Warranty Claim, Eligibility, Free Rework vs Chargeable Additional Work

HC-29 — Notification Orchestration

HC-30 — SLA & Provider Performance

HC-31 — BM Super App Integration APIs, Callbacks, Outbox/Webhooks, Idempotency & Replay Protection

HC-32 — Reporting/Read Models for Customer, Provider and BM Finance/Operations

HC-33 — Security, RBAC/Data Scope, Privacy, Retention & Audit Closure

HC-34 — Exception-State Orchestration & Lifecycle Consistency

HC-35 — Full Backend End-to-End Journey Validation

---

## AUTHORITATIVE JOURNEY

Tenant / Customer
→ BM Super App
→ Secure Handyman Handoff
→ Service Discovery
→ Service Request
→ Triage
→ Inspection
→ Diagnosis
→ Scope Classification
→ Quotation
→ Customer Approval
→ Work Order
→ Provider Dispatch
→ Crew Assignment
→ Schedule
→ Building Policy / Permit
→ Arrival
→ Location Verification
→ Crew Check-In
→ Work Session
→ Material Execution
→ Work Complete
→ Self-QC
→ Defect/Finding if required
→ Rectification
→ Re-Inspection
→ Evidence Complete
→ QC Complete
→ Digital BAST
→ Customer Acceptance / Dispute
→ Final Charge
→ Customer Transaction
→ Payment
→ Provider Entitlement
→ BM Fee Entitlement
→ Settlement / Reconciliation
→ Warranty Active
→ Warranty Claim / Rework if required
→ Closed

---

## EXISTING ASENTRA CAPABILITY RULE

Prefer REUSE for:

- Building/location hierarchy
- Tenant/Tenant PIC
- Vendor/provider
- Workforce
- Work Order
- Permit
- Scheduling where compatible
- Checklist engine
- Finding/Rework
- SLA
- Notification
- WhatsApp/Email/Push infrastructure
- Outbox/Webhook
- Audit

Prefer EXTEND where required for Handyman:

- Tenant Service Request
- Service Catalog
- Evidence
- Inventory/Material
- BAST

Use existing Price Catalog as price authority/reference where compatible.

NEW Handyman capabilities may include:

- Super App secure handoff
- Channel attribution
- Work Crew
- Work Session
- Handyman pricing execution
- Commercial Agreement / fee-rule execution
- Customer transaction ledger
- Provider entitlement
- BM fee entitlement
- Settlement/reconciliation
- Service warranty/claim

Do not create duplicate engines where an existing Asentra capability can satisfy the requirement through reuse or a bounded extension.

---

## CLIENT ARCHITECTURE

Tenant/customer:
Phase 1:
BM Super App
→ Embedded Handyman WebView
→ Handyman/Asentra backend APIs

Final:
BM Super App Native UI
→ same backend APIs

Lead Worker/PIC:
Dedicated production Work Crew Mobile App.

Helpers:
No smartphone or application login required.

Provider:
Dedicated Provider Operations Web workspace.

Building Management:
Dedicated Handyman extension in BM Operations workspace.

All clients use the same backend lifecycle authority.

---

## EXECUTION RULE

Implementation begins with HC-00.

For Arena execution:

- one small concern per PART;
- keep prompts ultra-light;
- inspect only directly relevant files;
- avoid broad repository audits;
- avoid unrelated refactoring;
- reuse existing foundations;
- use focused tests;
- do not implement future PARTs or waves early.

Each completed implementation unit follows:

Review
→ Fix if required
→ Focused Validation
→ Commit
→ Push
→ Pull Request when applicable.

---

## CHANGE CONTROL

Once HC-00 implementation begins, changes to HC-00–HC-35 top-level scope require an explicit CR.

Do not silently modify this frozen roadmap during later implementation.
