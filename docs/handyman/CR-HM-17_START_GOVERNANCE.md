# CR-HM-17 — Frontend Handyman Journey Integration — START GOVERNANCE

Date: 2026-09-30 (UTC)
Branch: `arena/01a0f11b-handyman-backend`
Base commit (BASELINE_HEAD): `5157645d309ac0ab05c42dda51fab989cde1d0fc`
(PR #9 "CR-HM-16: SLA, Notification, Audit & Reliability" MERGED into
`main`; assigned branch verified on latest `origin/main`.)

Governance ONLY. NO runtime, NO API/OpenAPI, NO migration, NO tests in
this PART. This document freezes the frontend journey integration
boundaries, the reuse posture, the blockers, and the smallest legal
PART split for CR-HM-17. It does not invent runtime, does not define
endpoints or schemas, and does not open any deferred backend gate.

Authoring repository for this PART: **Handyman-Backend** (the contract
authority that the journey-slice gate is evaluated against). The
PARTs in §9 execute in **Handyman-Frontend**.

## §1 Position in the frozen roadmap

Roadmap row 17: **Frontend Handyman Journey Integration**.

Repository: **Handyman-Frontend**.

Scope: bind frozen frontend journey to authoritative
Handyman-Backend contracts delivered by CR-HM-01..16 *as applicable*.

Runtime authority: **Handyman-Backend** (client is presentation/
orchestration only).

Depends on: **CR-HM-01..16 (journey-slice-gated)**.

Produces contract for: **CR-HM-22**.

Exit gate (verbatim):
> Frozen frontend journey bound only to published backend contracts;
> zero backend business rules duplicated client-side; journey parity
> review passed.

Preserve (roadmap): frontend remains presentation/orchestration
client; do NOT duplicate backend business rules.

Matrix rows consumed (all owned by Handyman-Backend; every one gives
the frontend a **presentation/orchestration consumer role only**):

| Matrix row | Capability | Frontend role at freeze | Dependency class |
| --- | --- | --- | --- |
| 1. Secure BM Super App Handoff | entry presentation only | orchestrator | A |
| 2. Channel Attribution | renders recorded value | presenter | A |
| 3. Handyman Service Request | intake/status presentation + orchestration | orchestrator | A |
| 4. Triage / Inspection / Diagnosis | presents decided outcome | presenter | A |
| 5. Specialist Escalation | presents referral state | presenter | A |
| 6. Service Catalogue | browsing/selection presentation | presenter | A |
| 7. Scheduling / Rescheduling | schedule presentation/orchestration | orchestrator | A |
| 8. Quotation | presents the exact version | presenter | A |
| 9. Customer Quotation Approval | decision presentation + capture | capturer | A |
| 10. Provider / Worker / Crew | presentation where journeys require | presenter | A |
| 11. Permit / Unit Access | status presentation | presenter | A |
| 12. Arrival & Location Verification | presents derived state | presenter | A |
| 13. Work Session | presents backend-owned session state | presenter | A |
| 14. Evidence | presents evidence as recorded | presenter | A |
| 15. Material Execution | option/cost visibility + approval surfaces | orchestrator | A |
| 16. QC / Checklist | QC outcome presentation | presenter | A |
| 17. Defect / Rectification / Reinspection | status presentation | presenter | A |
| 18. BAST / Customer Acceptance | acceptance presentation + capture | capturer | A |
| 19. SLA / Provider Performance | backend-derived SLA/performance state | presenter | A |
| 20. Customer Transaction / Payment | payment presentation/orchestration | orchestrator | A |
| 21. Commercial Agreement / BM Fee | read-model presentation where required | presenter | A |
| 22. Provider & BM Financial Entitlement | **none — backend-internal at freeze** | — | A |
| 23. Settlement / Reconciliation | **none — backend-internal at freeze** | — | A |
| 24. Service Warranty / Claim / Rework | claim intake/status presentation | presenter/capturer | A |
| 25. Notification / Communication | receives and presents | presenter | A |
| 26. Audit / Security / Reliability | subject to backend authz and audit | — | A |

Rows 22 and 23 carry **no frontend role at freeze** and are excluded
from CR-HM-17 scope entirely (§4.5, B6). CR-HM-01..16 are
**READ-ONLY authorities** for this CR; none is reopened or mutated
here.

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `git fetch origin --prune` | DONE |
| PR #9 | MERGED 2026-09-30T06:56:40Z, merge commit `5157645d309ac0ab05c42dda51fab989cde1d0fc`, base `main` |
| `origin/main` | `5157645d309ac0ab05c42dda51fab989cde1d0fc` |
| Session branch | `arena/01a0f11b-handyman-backend` |
| Branch based on that main | YES (`HEAD` = `merge-base` = `origin/main`) |
| BASELINE_HEAD | `5157645d309ac0ab05c42dda51fab989cde1d0fc` — fresh, no mismatch, not stale |
| Working tree | clean before this document |

Dependency ledger at this baseline — all CR-HM-01..16 are merged and
certified: PR #1 (HC-00), #2 (CR-HM-01..10), #3 (CR-HM-11), #4
(CR-HM-12), #5 (CR-HM-13), #6 (CR-HM-12 PART 06), #7 (CR-HM-14), #8
(CR-HM-15), #9 (CR-HM-16). Roadmap prerequisite *"No frontend/mobile
runtime CR may be created before the backend contract CR it requires"*
is satisfied at the CR level; §8 records where it is **not** satisfied
at the individual journey-slice level.

## §3 Published backend contracts read for this start

The journey-slice gate is evaluated against what is actually published
at BASELINE_HEAD — not against what a backend CR claims to own.

### 3.1 Published cross-process transport (Handyman routers, 11 files)

Mounted by `createApiRouter()` in `src/routes/index.ts` under the
versioned `/api/v1` prefix (CR-HM-01 frozen D3: never `/webhooks`).
OpenAPI surface in `docs/api/openapi.yaml`: **76 paths / 91 operations
(33 GET, 58 POST)** across `/handoff/*` and `/handyman/*`.

| Router module | Paths / ops | Journey stages served |
| --- | --- | --- |
| `handyman-handoff` (CR-HM-01) | 2 / 2 | entry context, attribution binding |
| `handyman-api` (CR-HM-02) | 5 / 6 | catalogue, request intake, intake evidence |
| `handyman-lifecycle-api` (CR-HM-03) | 4 / 8 | triage, inspection, diagnosis, referral |
| `handyman-provider-api` (CR-HM-04) | 12 / 12 | provider/worker/crew presentation |
| `handyman-readiness-api` (CR-HM-05) | 9 / 12 | scheduling / unit-access / permit readiness |
| `handyman-quotations-api` (CR-HM-06) | 10 / 13 | quotation, versions, issue/expire/supersede, **customer decision** |
| `handyman-scope-assignments-api` (CR-HM-04) | 2 / 3 | execution-scope assignment / reassignment |
| `handyman-arrival-verification-api` (CR-HM-07) | 1 / 1 | arrival verification (field capture) |
| `handyman-work-sessions-api` (CR-HM-08) | 9 / 9 | session events + active + time projection (field capture) |
| `handyman-material-execution-api` (CR-HM-09) | 8 / 8 | material estimate/approve/issue/purchase/use/return/settle + final-charge-ready |
| `handyman-evidence-qc-api` (CR-HM-10) | 14 / 17 | evidence records, QC runs/items, defect rectification/reinspection |

Transport authorization is the **reused shared** middleware
`authenticationMiddleware` + `requirePermission('tenant_company.read' | 
'tenant_company.manage')`. No Handyman-specific role or permission
vocabulary exists (§5.4, B5).

### 3.2 Published in-process read contracts — **zero transport**

Verified: none of the following modules contains a `*.routes.ts` or
`*controller*` file, and none is registered in `src/routes/index.ts`.

| Module | Published contract | Consumers named in its own certification |
| --- | --- | --- |
| `handyman-bast` (CR-HM-11) | `handyman-bast.read-contract.ts` — `HandymanBastAcceptanceReadContract`, `isHandymanCustomerBastAccepted`, `isHandymanWarrantyStartEligible`, `toHandymanBastAcceptanceReadContract` | CR-HM-15, **CR-HM-17/18** |
| `handyman-pricing-contract` (CR-HM-12) | `readHandymanPricingContractAt`, `readHandymanLaborPricingEvaluationAt`, `readHandymanMaterialPricingCompositionAt`, `readHandymanBmFeeRuleConsumptionAt`, `readHandymanBmFeeConfigurationAt` | CR-HM-06, **CR-HM-17**, CR-HM-13/14 |
| `handyman-customer-ledger-read` (CR-HM-13) | `readHandymanLedgerTransactionAt`, `readHandymanLedgerClientBasisAt` — `contractVersion: 'CR-HM-13-PART-06'`, `readOnly: true` | CR-HM-14, **CR-HM-17** |
| `handyman-financial-read` (CR-HM-14) | entitlement / settlement / reconciliation read family — `HANDYMAN_FINANCIAL_READ_CONTRACT_VERSION = 'CR-HM-14-PART-04'` | CR-HM-17 (conditional only) |
| `handyman-service-warranty-contracts` (CR-HM-15) | `HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION = '1'`, families warranty/claim/rework/chargeable, `readOnly: true` | **CR-HM-17/18** |
| `handyman-notifications` (CR-HM-16 P02) | 12-event meaning/audience/template contract, channel-free and provider-free | **CR-HM-17/18/22** |
| `handyman-audit` (CR-HM-16 P03) | 15-event audit vocabulary + context law; no injection endpoint | **CR-HM-17/18/22** |
| `handyman-provider-performance` (CR-HM-16 P04) | `HandymanProviderPerformanceSnapshot`; `HANDYMAN_PERFORMANCE_INPUT_LAW`; `HANDYMAN_PERFORMANCE_SEPARATION_LAW` | **CR-HM-17/18/22** |
| `handyman-evidence` (CR-HM-10 domain) | module domain; the HTTP seam is `handyman-evidence-qc-api` | — |

### 3.3 Deferred HTTP gates already on record (must not be reopened here)

- **CR-HM-13 PART 07 = NOT_REQUIRED**, `EXIT_GATE_BLOCKED = NO`. If
  CR-HM-17/18 later requires transport, *"PART 07 remains available as
  a thin wrapper over PART 01–06 commands with whitelist parsers and
  OpenAPI parity — never new business rules."*
- **CR-HM-14 PART 05 = NOT_REQUIRED now, required surface NONE**,
  triggered only if CR-HM-17/CR-HM-22 consumption requires transport;
  rows 22–23 are backend-internal at freeze.
- CR-HM-10/CR-HM-11/CR-HM-15/CR-HM-16 published module contracts with
  no HTTP and no stated transport requirement.

**This CR does not reopen, waive, or infer any of these gates.**

## §4 FROZEN ownership & reuse boundaries

### 4.1 Reuse-first (binding, mandatory)

The ownership matrix records Handyman-Frontend as **FROZEN; 223
canonical mappings; journey 20/20 COVERED; GAP 0; presentation/
orchestration client**. The frontend journey therefore already exists.
CR-HM-17 is a **binding** CR, not an authoring CR.

Every PART must carry a **reuse disposition** for each bound
surface, and only these four values are legal:

| Disposition | Meaning | Legal here |
| --- | --- | --- |
| `REUSE_EXISTING` | existing frontend capability already satisfies the step; no change | YES |
| `REBIND` | existing capability, data source swapped to a published backend contract | YES |
| `EXTEND_EXISTING` | existing capability, additional field/branch rendered from an already-published contract | YES |
| `NEW` | a new frontend capability is created | **FORBIDDEN** without a recorded, reviewed rejection of every existing candidate in the reuse inventory (PART 01) and an explicit cross-CR amendment |

A `NEW` disposition on this CR is a STOP (B3). The journey is 20/20
COVERED at freeze; "not yet bound" is never "does not exist".

### 4.2 Reuse inventory is a hard prerequisite (PART 01)

Because the reuse inventory cannot be assumed, the first implementation
PART is an explicit inventory-and-map step over the real
Handyman-Frontend tree. No binding, no component change, and no
authoring may precede it.

### 4.3 Backend remains the lifecycle authority (binding)

For every journey step: the backend publishes the state, the
transition, the amount, the eligibility, the clock, and the
authorization. The frontend renders, sequences navigation, captures
intent, and submits. It never derives any of them.

### 4.4 No business-rule duplication (binding)

Forbidden in the client, without exception: pricing evaluation and
pricing mode logic; quotation total/line computation; SLA target,
elapsed, pause, breach, or escalation computation; entitlement,
settlement, reconciliation, and net/gross computation; warranty
eligibility and warranty-start computation; triage/diagnosis/scope
decisions; escalation/referral decisions; material final-charge
computation; session time separation; arrival risk/confidence
scoring; any state-machine transition rule.

### 4.5 SaaS plane exclusion (binding)

CR-HM-17 renders **nothing** from Asentra-SaaS control-plane state
(rows 27–30): no product/package presentation as a Handyman offer, no
subscription state, no SaaS entitlement gate on any journey step, no
SaaS integration health surface (row 34). SaaS Package Price !=
Handyman quotation/final charge. SaaS Billing != Handyman Customer
Transaction Ledger. SaaS Product Entitlement != Provider/BM Financial
Entitlement.

### 4.6 Out-of-journey domains (binding)

Matrix rows 22 (Provider & BM Financial Entitlement) and 23
(Settlement / Reconciliation) are **backend-internal at freeze** and
have no frontend role. CR-HM-17 must not create a surface for them,
even as a placeholder, and must not present settlement status as a
customer-visible fact.

## §5 Authority separations (FROZEN)

Carried forward verbatim from the capability map, the ownership
matrix, and the CR-HM-01..16 certifications. The frontend renders
these distinctions; it never collapses them.

1. `QR != proof of presence`; `Permit/Access != verified arrival`;
   `Arrival Verification != CHECK-IN`.
2. `CHECK-IN != START WORK`; `Presence Time != Actual Work Time !=
   Billable Time`.
3. `Quotation Approval != BAST Acceptance`;
   `Quotation Approval != Payment Confirmation`;
   `COMPLETE != BAST Acceptance`.
4. `Material usage != authoritative final material charge`; catalogue
   reference price is an input, never a charge.
5. `SaaS Package Price != Handyman quotation/final charge`.
6. `Asset Warranty != Handyman Service Warranty`; warranty starts only
   from an `ACCEPTED` BAST — never from COMPLETE, quotation approval,
   or QC PASS (CR-HM-11/CR-HM-15).
7. `SLA Engine != Provider Performance Read Model`; performance is
   derived from governed events, never manually entered.
8. Generic task/work-order/attendance/checklist/finding != Handyman
   Work Session / QC / defect semantics.

### 5.4 Shared authorization vocabulary is reuse, not a Handyman role model

`tenant_company.read` / `tenant_company.manage` are the reused shared
permission keys on the Handyman transport. Binding to them is
REUSE_WITH_CONTEXT. It does **not** create, imply, or substitute a
Handyman role, actor, or authorization model, and the frontend must
never branch journey behaviour on those key names.

## §6 Frozen frontend journey integration boundary

Nine stages, in the order named by this CR. For each: what the
frontend may do, what backend contract is bound, and the transport
state at BASELINE_HEAD.

### S1 — request / catalogue

Frontend: browse and select catalogue services/variants/material
profiles, orchestrate request intake, submit intake evidence, render
immutable channel attribution exactly as recorded.
Backend bound: CR-HM-01 handoff/attribution (2 ops), CR-HM-02
catalogue + request + intake evidence (6 ops).
Transport: **AVAILABLE**.
Forbidden: composing a request lifecycle locally; mutating or
inferring attribution; treating a reference price as a charge.

### S2 — triage

Frontend: present triage / inspection / diagnosis / referral outcomes
as decided; show original request and history preserved; present
exclusion/scope classification; present referral state and target.
Backend bound: CR-HM-03 lifecycle (8 ops).
Transport: **AVAILABLE**.
Forbidden: any triage, inspection-necessity, diagnosis, scope, or
escalation decision logic; converting a referral into another
workflow; absorbing an excluded case into a Handyman step.

### S3 — quotation / approval

Frontend: present the exact presented quotation version — labor lines,
material lines, price snapshot, expiry, revisions — and capture the
customer APPROVE / REJECT / permitted-revision intent against that
version.
Backend bound: CR-HM-06 quotation surface (13 ops, including
`/decision`), CR-HM-12 pricing read (module only, see S7).
Transport: **AVAILABLE** for presentation and decision capture.
Forbidden: composing, recomputing, rounding, totalling, re-pricing, or
altering a quotation; letting a later catalogue/price change mutate a
presented version; presenting a decision as payment or as acceptance;
creating a revision without the backend command.

### S4 — scheduling / access

Frontend: present scheduling / unit-access / permit readiness and its
history, present supersession, present execution-scope assignment;
orchestrate a reschedule request intent.
Backend bound: CR-HM-05 readiness (12 ops), CR-HM-04 assignment (3
ops).
Transport: **AVAILABLE**.
Forbidden: client-side scheduling rules or availability computation;
permit applicability decisions; presenting readiness as verified
arrival or as work start.

### S5 — execution tracking

Frontend: present backend-owned arrival/verification result, session
state, material line state, evidence/QC/defect state and time
projection as derived state.
Backend bound: CR-HM-07 (1 op), CR-HM-08 (9 ops), CR-HM-09 (8 ops),
CR-HM-10 (17 ops).
Transport: **AVAILABLE** for reading.
Forbidden: client-side presence/work/billable time computation; risk
or confidence scoring; a second command client for field-execution
verbs (see B10); material final-charge computation; QC pass/fail
judgement.

### S6 — QC / BAST

Frontend: present QC run outcomes and defect/rectification/reinspection
state; present BAST document and acceptance state; capture the customer
acceptance decision.
Backend bound: CR-HM-10 (HTTP; 5 evidence ops, 5 QC ops, 7
defect ops), CR-HM-11 `handyman-bast` read contract.
Transport: **PARTIAL** — QC/evidence/defect **AVAILABLE**; BAST and
customer acceptance **NOT AVAILABLE** (no router, no OpenAPI path).
Forbidden: inferring acceptance from COMPLETE or from QC PASS; gating
acceptance on quotation approval; presenting an acceptance record the
backend did not record. **B1 applies to the BAST half of S6.**

### S7 — payment

Frontend: present the backend-published charge picture and orchestrate
a payment intent; show allocation and correction facts; show net
figures only as published.
Backend bound: CR-HM-13 `readHandymanLedgerTransactionAt` /
`readHandymanLedgerClientBasisAt`, CR-HM-12 pricing contract,
CR-HM-14 financial read.
Transport: **NOT AVAILABLE** — CR-HM-13 PART 07 recorded
`NOT_REQUIRED`; CR-HM-14 PART 05 recorded `NOT_REQUIRED`.
Forbidden: any client-side amount computation; presenting a ledger
gross figure as the payable figure; treating a payment as recorded
before the backend records it; entitlement/settlement presentation.
**B1 applies. S7 is not startable.**

### S8 — warranty / claim

Frontend: present warranty head, claim state, rework state, and
chargeable-additional-work separation; capture a claim intake intent.
Backend bound: CR-HM-15 `HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION =
'1'` read contract.
Transport: **NOT AVAILABLE** (no router, no OpenAPI path).
Forbidden: client-side eligibility or warranty-start computation;
starting warranty from anything other than an `ACCEPTED` BAST;
collapsing free warranty rework into chargeable work or vice versa;
presenting asset warranty as service warranty. **B1 applies.**

### S9 — SLA / status visibility

Frontend: present backend-derived SLA clock/breach/escalation state,
notification records, and the provider performance snapshot; present
journey status assembled **only** from published statuses.
Backend bound: CR-HM-16 PART 01 SLA milestone vocabulary over the
shared engine, PART 02 notification contract, PART 03 audit and
integration vocabulary, PART 04 `HandymanProviderPerformanceSnapshot`.
Transport: **NOT AVAILABLE** (no Handyman router for any of the four).
Forbidden: client-side SLA target/elapsed/breach/escalation
computation; defining event meaning, audience, or templates; any KPI
entry or performance entry; any security, audit, or authorization
decision; inferring a journey status the backend did not publish.
**B1 applies.**

### 6.1 Transport coverage summary (verified at BASELINE_HEAD)

| Stage | Contract published | Transport published | Startable |
| --- | --- | --- | --- |
| S1 request/catalogue | YES | YES (8 ops) | after PART 01 |
| S2 triage | YES | YES (8 ops) | after PART 01 |
| S3 quotation/approval | YES | YES (13 ops) | after PART 01 |
| S4 scheduling/access | YES | YES (15 ops) | after PART 01 |
| S5 execution tracking | YES | YES (35 ops, read) | after PART 01 |
| S6 QC / BAST | YES | QC YES / **BAST NO** | QC only; BAST blocked |
| S7 payment | YES (module) | **NO** | BLOCKED |
| S8 warranty/claim | YES (module) | **NO** | BLOCKED |
| S9 SLA/status | YES (module) | **NO** | BLOCKED |

**5 of 9 journey stages are bindable now. 4 are not.** This is the
single most important finding of this START.

## §7 Minimum mapped seams (FROZEN)

1. **Entry/context seam (CR-HM-01)** — the frontend consumes the
   backend-established session/context. The handoff exchange is an
   *assertion* exchange: CR-HM-01 frozen D1/D2 records that **no
   standard user session is created, no Bearer token is minted, and
   the `handoffAssertionSignature` scheme never falls back to Bearer**.
   The frontend may never present the exchange as a login, derive a
   session from it, or manufacture credentials.
2. **Attribution seam (CR-HM-01)** — attribution is rendered
   exactly as recorded and is never settable from the client.
3. **Catalogue/request seam (CR-HM-02)** — read + bounded intake; the
   evidence intake seam is a bounded interface, not the full evidence
   lifecycle (that authority is CR-HM-10).
4. **Decision seam (CR-HM-03)** — outcomes are read-only inputs to
   the client; only the quotation decision in CR-HM-06 is a customer
   *capture*.
5. **Quotation seam (CR-HM-06)** — the presented version is the only
   renderable object; the decision is version-bound.
6. **Readiness/assignment seam (CR-HM-05/04)** — readiness history
   and supersession are rendered as history, never as the current
   truth without the current read.
7. **Execution-state seam (CR-HM-07/08/09/10)** — presentation only
   in this CR; command binding is CR-HM-18's (mobile field client).
8. **Financial seam (CR-HM-12/13/14)** — **closed at this baseline**.
   Reusable only if and when a transport gate is reopened by the owning
   backend CR (§3.3). Not by this CR.
9. **Warranty seam (CR-HM-15)** — **closed at this baseline**, same
   rule.
10. **Observability seam (CR-HM-16)** — notification/audit/
    performance/SLA contracts are **closed at this baseline** for
    transport purposes; the client may not reconstruct any of them.
11. **FM firewall** — no FM work order, checklist, finding,
    attendance, vendor, catalogue, or schedule semantics may be
    adopted as Handyman journey truth; no FM endpoint may be rendered
    as a Handyman stage.
12. **SaaS firewall** — §4.5.
13. **Outbox/webhook seam** — CR-HM-16's subscription contract is an
    integration seam. The frontend does not consume delivery
    channels as a state source and defines no event meaning.

## §8 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| **B1** | **Missing transport for a journey stage.** BAST/acceptance (CR-HM-11), payment (CR-HM-13/12/14), warranty/claim (CR-HM-15) and SLA/status visibility (CR-HM-16) are published as **in-process, zero-HTTP, read-only module contracts**. A browser client cannot reach them. | **STOP** for S6(BAST), S7, S8, S9. Do not infer, proxy, scrape, recompute, or stand up a client-side substitute. Resolution requires the **owning backend CR** to reopen its own conditional HTTP gate (`CR-HM-13 PART 07`, `CR-HM-14 PART 05`, or an equivalent gate in CR-HM-11/15/16) as a **thin, actor-scoped, read-only transport over the already-published contract, with OpenAPI parity and no new business rules**. CR-HM-17 may request and consume that; it may **not** create it. |
| **B2** | **Handyman-Frontend is not reachable from this environment.** Not present under `/home/user`; `gh repo list budiirmawan` returns only `Handyman-Backend`. The "223 canonical mappings / journey 20/20 COVERED / GAP 0" fact is a *supplied frozen* input of the ownership matrix, not an inspected one. | **STOP** before any binding. The reuse inventory must be produced and verified against the real frontend tree as PART 01 (§4.2). No reuse disposition may be asserted from the frozen summary alone. |
| **B3** | **Business-rule duplication** in the client (any rule enumerated in §4.4, or any client-owned state machine that implies a transition the backend did not publish). | STOP. The backend is the lifecycle authority; a missing published status is a gap report, never a client default. |
| **B4** | **Client-asserted authority or state** (client decides status, computes amounts, infers acceptance, infers warranty start, asserts payment state, writes attendance/check-in, mutates attribution, or treats a rendered value as a command result before the backend records it). | STOP. Render and capture only. |
| **B5** | **FM coupling** (adopting FM work-order, checklist, finding, attendance, vendor, catalogue, or schedule semantics as Handyman journey truth; rendering an FM endpoint as a Handyman stage; treating the reused `tenant_company.*` permission keys as a Handyman role model). | STOP. Firewall §4.3/§5.4/§7.11. |
| **B6** | **SaaS coupling** (any SaaS product, package, subscription, entitlement, provisioning, or integration-health state gating or annotating a Handyman journey step; rendering SaaS package price as a quotation). | STOP. §4.5; rows 22–23 remain out of scope entirely (§4.6). |
| **B7** | **Second command client for field-execution verbs** (arrival verification, session events, material issue/use/return, defect rectification, QC capture) bound by the frontend. | STOP. Those are CR-HM-18 (Mob-Handyman) field-execution bindings; the frontend may present their backend-owned state read-only in S5. |
| **B8** | **Transport or adapter invention** in this CR (new endpoint, BFF/proxy, direct database access, scraping an internal module, or a hand-written client adapter to an unpublished in-process contract). | STOP. No runtime, no API, no migration, no adapter in the governance and binding PARTs. |
| **B9** | **Identity/authorization decision client-side**, including treating the CR-HM-01 handoff exchange as a session, deriving a Bearer token from it, or branching on shared permission key names. | STOP. §7.1, §5.4. |
| **B10** | **`NEW` frontend capability** created without a recorded, reviewed rejection of every existing reuse candidate from the PART 01 inventory and an explicit cross-CR amendment. | STOP. The journey is 20/20 COVERED at freeze (§4.1). |
| **B11** | **Runtime, API/OpenAPI, migration, schema, or test change in this governance PART.** | STOP. Governance only. |

Non-blockers (explicitly deferred; **no authority implied**): visual
design, design system, i18n, accessibility work, analytics, marketing
surfaces, offline/idempotency semantics (CR-HM-18), real channel
providers, SLA business-day/holiday calendars, entitlement/settlement
presentation (rows 22–23), provider-performance UI specifics, and all
CR-HM-22 certification mechanics.

## §9 Smallest PART split

Each PART is the smallest unit that is independently deliverable and
independently certifiable against the frozen boundaries. No PART
authors a new journey stage; every PART is a binding PART.

| PART | Name | Status | Allowed | Forbidden |
| --- | --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | **DONE — this commit** | Freeze journey boundary, reuse posture, separations, blockers, split | Runtime, API/OpenAPI, migration, schema, tests, reopened gates |
| **01** | Reuse inventory + journey binding map | **STARTABLE (first mandatory step)** | Verify the 223-mapping / 20-of-20-COVERED reuse claim against the real Handyman-Frontend tree; publish stage→existing-capability→published-contract→transport map; record a reuse disposition per surface (§4.1) | Any binding, component change, or `NEW` capability; asserting a disposition from the frozen summary alone (B2) |
| **02** | Entry/context + request/catalogue + triage binding (S1, S2) | STARTABLE after PART 01 | `REBIND`/`EXTEND_EXISTING` to handoff, attribution, catalogue, request, intake evidence, triage/inspection/diagnosis/referral | Identity decisions (B9); client lifecycle rules (B3); new stage (B10) |
| **03** | Quotation + customer approval binding (S3) | STARTABLE after PART 01 | Present the exact presented version; capture APPROVE/REJECT/permitted-revision intent to the backend decision command | Totalling, re-pricing, version mutation, approval→payment/acceptance collapse |
| **04** | Scheduling/access + execution tracking presentation (S4, S5) | STARTABLE after PART 01 | Readiness/history/supersession, assignment read, and **read-only** arrival/session/material/evidence/QC/defect/time-projection presentation | Field command binding (B7); time or risk computation; material final charge; readiness-as-arrival |
| **05** | QC + BAST/acceptance binding (S6) | **PARTIAL — QC arm startable after PART 01; BAST arm BLOCKED by B1** | QC run/defect state presentation; acceptance presentation/capture **only after** a CR-HM-11 transport exists | Inferring acceptance from COMPLETE or QC PASS; presenting a locally-composed acceptance |
| **06** | Payment presentation/orchestration (S7) | **BLOCKED by B1** | Nothing until CR-HM-13/12/14 transport exists | Any amount computation; gross-as-payable; client-asserted payment state; rows 22–23 surfaces |
| **07** | Warranty/claim presentation (S8) | **BLOCKED by B1** | Nothing until a CR-HM-15 transport exists | Eligibility or warranty-start computation; warranty from anything but an `ACCEPTED` BAST; free-vs-chargeable collapse |
| **08** | SLA / status visibility (S9) | **BLOCKED by B1** | Nothing until CR-HM-16 transport exists | SLA/clock/breach/escalation computation; event meaning; KPI entry; security/audit decisions; inferred journey status |
| **09** | Journey parity review + firewall verification (exit gate) | LAST | Verify: every bound surface is `REUSE_EXISTING`/`REBIND`/`EXTEND_EXISTING`; zero duplicated business rules; zero client-asserted state; FM and SaaS firewalls intact; §5 separations preserved; every unbindable stage reported as a gap, not a substitute | Closing the exit gate while any stage is silently substituted, inferred, or stubbed |

Sequencing law:

1. Do not start PART 02..08 until PART 00 is committed on the assigned
   branch.
2. Do not start **any** binding PART before PART 01 is committed
   (B2, §4.2).
3. Do not start the PART 05 BAST arm, or PART 06, 07, 08 at all, until
   the owning backend CR has reopened and delivered its transport gate
   (§3.3, B1). A reopened gate must be published and merged into
   `main` **before** the corresponding frontend PART begins.
4. PART 09 may report a stage as blocked, but may never certify the
   roadmap exit gate with a stage substituted, inferred, or stubbed.
5. PART 09 output is the sole input to CR-HM-22 contract parity.

## §10 Out of scope

- No runtime, no SQL/migration, no HTTP/OpenAPI, no tests in this
  PART; no runtime/API/migration/test change in any PART of this CR
  (binding is a client change only).
- No reopening or waiving of CR-HM-13 PART 07, CR-HM-14 PART 05, or
  any other deferred gate — those are opened by their **owning**
  backend CR.
- No new backend authority, no new Handyman domain, no new state, no
  new event, no new notification meaning.
- No CR-HM-18 field-execution command binding.
- No CR-HM-19/20/21 SaaS work; no CR-HM-22 certification mechanics.
- No changes to the frozen roadmap, capability map, or ownership
  matrix; a classification/ownership change requires its own CR.
- No mobile, native, or device concerns.

## Handoff

CR-HM-17 binds the **already-covered** Handyman-Frontend journey
(20/20 COVERED, 223 mappings, GAP 0 at freeze) to the **already-
published** Handyman-Backend contracts. It authors no journey stage,
no business rule, and no transport.

**S1–S5 bind now** (91 published operations across 11 Handyman
routers, 76 OpenAPI paths) once PART 01 publishes the verified reuse
inventory.

**S6(BAST), S7, S8 and S9 do not.** Their contracts are published as
in-process, zero-HTTP, read-only module contracts and are unreachable
by a browser client. The resolution is **not** in this CR: the owning
backend CRs (CR-HM-11, CR-HM-13/12/14, CR-HM-15, CR-HM-16) must
reopen their own conditional transport gates as thin, actor-scoped,
read-only wrappers with OpenAPI parity over the contracts they already
published — adding no business rule. Until then those stages are
reported as **contract-published / transport-absent** and are rendered
as explicit gaps, never as client substitutes.

CR-HM-18 (mobile) is unaffected by this decision and remains the
field presentation/execution client for the S5 command surface.
CR-HM-22 consumes the PART 09 parity result.

**STOP.**
