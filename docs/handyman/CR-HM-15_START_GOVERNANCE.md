# CR-HM-15 — Service Warranty, Claim & Rework — START GOVERNANCE

Date: 2026-09-30 (UTC)
Branch: `arena/01a0f02c-handyman-backend`
Base commit: `e259309` (`origin/main` = `f46b0e05ae15dd9d41cc42752011a004727ce6b8`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI/tests in this
PART. This document freezes ownership, aggregate, lifecycle,
authority, blockers, and the smallest legal PART split for CR-HM-15.
Does not invent runtime.

## §1 Position in the frozen roadmap

Roadmap row 15: **Service Warranty, Claim & Rework**.

Scope vocabulary: *workmanship warranty; material warranty; warranty
start after accepted BAST; claim; eligibility; free warranty rework;
chargeable additional work separation*.

Primary authority: **Handyman-Backend**.

Depends on (roadmap): **CR-HM-11**.

Produces contract for: **CR-HM-17, CR-HM-18**.

Exit gate:
> Warranty, claim, and rework contracts published;
> Asset Warranty != Handyman Service Warranty verified;
> Only `ACCEPTED` BAST starts warranty; no inference from COMPLETE/QC PASS.

Preserve (roadmap):
- Asset Warranty != Handyman Service Warranty

CR-HM-11 is treated as a **READ-ONLY prerequisite** for this start
(BAST acceptance already certified). CR-HM-11 is not reopened, not
mutated, and does not own warranty gating.

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `origin/main` | `f46b0e05ae15dd9d41cc42752011a004727ce6b8` |
| Session branch | `arena/01a0f02c-handyman-backend` |
| Branch based on that main | YES (`merge-base` ancestor OK; HEAD = `e259309`) |
| CR-HM-11 (roadmap Depends On) | READ-ONLY consumer: BAST `ACCEPTED` is the ONLY warranty start eligibility |
| CR-HM-11 FINAL CERTIFICATION | READ-ONLY prerequisite: BAST `ACCEPTED` status only |
| CR-HM-10 FINAL CERTIFICATION | READ-ONLY: QC/defect/evidence sequenced truth only |
| CR-HM-08 session seam | READ-ONLY: session COMPLETE/CHECK_OUT ≠ warranty start |

## §3 FROZEN ownership

ONE authority: **CR-HM-15 / Handyman-Backend** owns Handyman
service warranty, claim, and rework lifecycle — the transactional
warranty record for an execution scope, bound to a customer-accepted
BAST.

| Surface | Owner | This CR |
| --- | --- | --- |
| Warranty header + state (workmanship + material) | CR-HM-15 | AUTHORITY |
| Warranty start eligibility (only `ACCEPTED` BAST) | CR-HM-11 | READ-ONLY CONSUMER |
| Claim intake / evidence / decision | CR-HM-15 | AUTHORITY |
| Free warranty rework execution | CR-HM-15 | AUTHORITY |
| Chargeable additional work separation | CR-HM-15 | AUTHORITY |
| BAST acceptance state / sign-off | CR-HM-11 | READ-ONLY |
| QC / defect / rectification / evidence records | CR-HM-10 | READ-ONLY |
| Work session COMPLETE / CHECK_OUT | CR-HM-08 | READ-ONLY |
| Quotation version + customer approval | CR-HM-06 | READ-ONLY |
| Authorized execution scope | CR-HM-06 | READ-ONLY TARGET |
| Customer transaction / payment / ledger | CR-HM-13 | NOT this CR |
| Provider/BM entitlement / settlement | CR-HM-14 | NOT this CR |
| FM Asset Warranty / legacy Vendor Warranty | FM engineering ops | FIREWALL |

**FK discipline (frozen):** new FKs point to Handyman tables
(`handyman_execution_scopes`, optional read refs to BAST / claim /
evidence / rework records) and generic realm (`users`, `clients`) ONLY
— NEVER to FM `asset_warranties`, FM `warranty_claims`, or Vendor
Warranty tables.

Infra reuse ≠ authority transfer. Shared document/storage primitives
may hold bytes; they never own warranty status.

## §4 TARGET + ACTOR

**TARGET:** one `HANDYMAN_EXECUTION_SCOPE` (CR-HM-06 AUTHORIZED
scope) with a **customer-accepted BAST** (`ACCEPTED` status).
Warranty never attaches to FM work order, request, quotation header
alone, or session row as owner. Warranty is scoped to the execution
scope that achieved customer acceptance.

**ACTOR (claim authority):** the customer (or customer-delegated
claimant) bound to that scope's client. Crew Lead COMPLETE is
**never** a warranty claim trigger. Caller-supplied "claim=true"
without a governed transition is rejected.

Provider/lead may **open** a claim draft for customer decision.
Only the customer-side claimant **submits / withdraws** a claim.

Lead/provider may **propose** a rework scope (warranty or
chargeable). Only the customer-side acceptor **accepts / rejects**
the rework proposal.

## §5 Lifecycle (frozen — names only, no runtime)

### Warranty lifecycle (per execution scope)

Single authoritative Handyman warranty status per scope. Bounded:

```text
INELIGIBLE       — no ACCEPTED BAST for this scope (not started)
ACTIVE           — ACCEPTED BAST exists; within warranty period
CLAIM_OPEN       — customer submitted a claim; under review
CLAIM_APPROVED   — claim approved; free rework authorized
CLAIM_REJECTED   — claim rejected; chargeable path available
REWORK_IN_PROGRESS — free rework authorized and started
REWORK_COMPLETE  — free rework done; awaiting verification
EXPIRED          — warranty period elapsed; no further claims
```

Warranty **state** is the warranty status column (or a 1:1
projection of it). Claim/rework records do **not** independently
become truth.

### Warranty types (frozen vocabulary)

- **Workmanship Warranty** — covers labor quality defects; starts
  at BAST `ACCEPTED`; duration governed by commercial agreement
  (CR-HM-12) but authority here.
- **Material Warranty** — covers material defects; starts at BAST
  `ACCEPTED`; duration governed by material supplier terms but
  authority here.

**FROZEN separations:**

```text
session COMPLETE     != Warranty Start     (CR-HM-08)
CHECK_OUT            != Warranty Start
BAST ACCEPTED        == Warranty Start     (ONLY eligibility)
QC PASS              != Warranty Start     (CR-HM-10)
Asset Warranty       != Handyman Service Warranty
```

CR-HM-11 **may consume** CR-HM-08 COMPLETE and CR-HM-10 QC/defect
read models as **gates it defines**. Those modules never write
warranty. Gating policy (whether COMPLETE and/or QC PASS is
required before warranty start) is **owned in CR-HM-11** and frozen
in CR-HM-11 PART 03 — not invented as runtime here.

Claim/rework lifecycle:

```text
CLAIM_DRAFT       — prepared; not submitted
CLAIM_SUBMITTED   — customer submitted; awaiting review
CLAIM_APPROVED    — approved; free rework authorized
CLAIM_REJECTED    — rejected; chargeable path available
CLAIM_WITHDRAWN   — customer withdrew; no rework
REWORK_DRAFT      — rework scope proposed; not accepted
REWORK_AUTHORIZED — free rework scope accepted; work may start
REWORK_IN_PROGRESS — rework execution started
REWORK_COMPLETE   — rework done; awaiting verification
REWORK_VERIFIED   — rework verified; claim closed
REWORK_CHARGEABLE — chargeable additional work authorized (separate)
```

Legal intent (guards, not APIs):

| Action | Meaning |
| --- | --- |
| CLAIM_SUBMIT | CLAIM_DRAFT → CLAIM_SUBMITTED (customer claimant + evidence) |
| CLAIM_APPROVE | CLAIM_SUBMITTED → CLAIM_APPROVED (authority + evidence review) |
| CLAIM_REJECT | CLAIM_SUBMITTED → CLAIM_REJECTED (authority; reason recorded) |
| CLAIM_WITHDRAW | CLAIM_SUBMITTED → CLAIM_WITHDRAWN (customer; no rework) |
| REWORK_PROPOSE | CLAIM_APPROVED → REWORK_DRAFT (lead/provider proposes scope) |
| REWORK_ACCEPT | REWORK_DRAFT → REWORK_AUTHORIZED (customer accepts) |
| REWORK_START | REWORK_AUTHORIZED → REWORK_IN_PROGRESS (crew starts) |
| REWORK_COMPLETE | REWORK_IN_PROGRESS → REWORK_COMPLETE (crew finishes) |
| REWORK_VERIFY | REWORK_COMPLETE → REWORK_VERIFIED (verification pass) |
| REWORK_CHARGE | REWORK_DRAFT → REWORK_CHARGEABLE (customer rejects free scope; chargeable path) |

## §5.1 Warranty start boundary (FROZEN)

Only **CR-HM-11 `ACCEPTED` BAST** may start a service warranty.
This is the **sole** eligibility gate.

- `ACCEPTED` BAST → warranty `ACTIVE` (both workmanship + material)
- Any other state (DRAFT, ISSUED, REJECTED, VOID) → warranty `INELIGIBLE`
- Session COMPLETE, QC PASS, CHECK_OUT, Quotation Approval → **never** warranty start

Warranty duration/terms are governed by commercial agreement
(CR-HM-12) and material supplier terms — not invented here.

## §6 Minimum mapped seams (FROZEN)

No broad audit. Only seams required to freeze this CR:

1. **CR-HM-11 BAST seam (inbound)** — only `ACCEPTED` BAST status
   starts warranty; CR-HM-15 consumes this as read-only eligibility.
   CR-HM-11 owns gating policy; CR-HM-15 never maps COMPLETE/QC
   PASS → warranty start.
2. **CR-HM-10 evidence/QC/defect seam (inbound)** — evidence
   records, QC outcomes, defect states are sequenced truth; CR-HM-15
   binds them as **claim evidence references** without ownership
   transfer. WARRANTY/CLAIM remain out of CR-HM-10 vocabulary
   (already certified).
3. **CR-HM-08 session seam (inbound)** — COMPLETE/CHECK_OUT publish
   field completion; CR-HM-15 reads; never maps COMPLETE →
   warranty start.
4. **CR-HM-13 payment/ledger seam (outbound)** — chargeable
   additional work separation publishes a payment trigger; CR-HM-13
   owns payment/ledger; CR-HM-15 only emits the separation fact.
4. **CR-HM-17/18 presentation seam (outbound)** — clients
   display/submit claim/rework commands against published contracts
   only.
5. **FM Asset Warranty firewall** — FM BE-XX / Vendor Asset
   Warranty conflicts documented in cross-repo review are **out of
   this CR**. Handyman does not become FM Asset Warranty-01 and
   does not dual-write FM warranty status.

## §7 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | CR-HM-08 session COMPLETE used as warranty start | STOP; only `ACCEPTED` BAST starts warranty (CR-HM-11) |
| B2 | CR-HM-10 QC PASS used as warranty start | STOP; CR-HM-10 is read-only sequenced truth |
| B3 | CR-HM-11 BAST `ISSUED`/`COMPLETE`/`QC_PASS` used as warranty start | STOP; only `ACCEPTED` BAST is eligibility |
| B4 | Asset Warranty / FM Warranty reused as Handyman authority | STOP; firewall; no dual-write |
| B5 | Runtime/migration/API in a governance PART | STOP |
| B6 | Payment/ledger/entitlement implemented here | STOP (CR-HM-13 / 14) |
| B7 | Asset Warranty treated as Handyman Service Warranty | STOP (roadmap preserve) |
| B8 | Free rework and chargeable additional work collapsed | STOP; must remain separated |
| B9 | Claim/rework lifecycle implemented in CR-HM-10 or CR-HM-11 | STOP; authority is here |

Non-blockers (explicitly deferred): FM Asset Warranty
consolidation, vendor settlement COM-02, permit-to-warranty EXT-XX,
SaaS warranty exposure, credit-note documents.

## §8 Smallest PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | Freeze ownership/lifecycle/authority/blockers/split | Runtime, migration, API |
| **01** | Warranty aggregate + transitions | Authoritative warranty row per scope, status guards, INELIGIBLE→ACTIVE→CLAIM_OPEN→CLAIM_APPROVED/REJECTED, EXPIRED | Claim intake HTTP, rework, chargeable separation, FM sync |
| **02** | Claim intake / decision / evidence bind | State-gated SUBMIT/APPROVE/REJECT/WITHDRAW + evidence bind | Rework scope, chargeable separation, payment |
| **03** | Free rework lifecycle | REWORK_DRAFT→AUTHORIZED→IN_PROGRESS→COMPLETE→VERIFIED (warranty only) | Chargeable separation, payment, FM sync |
| **04** | Chargeable additional work separation | Chargeable scope proposal + customer accept/reject; payment trigger for CR-HM-13 | Free rework mutation, payment ledger, FM sync |
| **05** | Published read contract | Contracts for CR-HM-17/18; Asset Warranty firewall checks; Asset!=Service Warranty | New authority, FM projection as truth |

Do not start PART 01 until this START is committed on the assigned
branch. Do not merge PART 02 before PART 01 status authority exists.
Do not treat PART 03 as a second write path for claim/rework.

## §9 Out of scope

- No OpenAPI, no HTTP, no SQL, no tests in this PART.
- No FM Asset Warranty transition API, no legacy Vendor Warranty projection.
- No customer ledger, no payment engine, no pricing, no entitlement.
- No SaaS warranty exposure.

## Handoff

CR-HM-15 consumes **CR-HM-11 `ACCEPTED` BAST** as the **only**
eligibility for workmanship/service warranty start.

CR-HM-17/18 consume the published warranty/claim/rework
read+command contracts. CR-HM-13 must not infer payment from
chargeable additional work without its own CR. CR-HM-14 must not
derive entitlement from warranty claim without its own CR.

STOP after this governance PART.