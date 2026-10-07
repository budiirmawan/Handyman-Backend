# CR-HM-11 — BAST & Customer Acceptance — START GOVERNANCE

Date: 2026-09-29 (UTC)
Branch: `arena/01a0ed85-handyman-backend`
Base commit: `f46b0e0` (`origin/main` = `f46b0e05ae15dd9d41cc42752011a004727ce6b8`)

Governance ONLY. NO migration, NO runtime/API/OpenAPI/tests in this
PART. This document freezes ownership, aggregate, lifecycle,
authority, blockers, and the smallest legal PART split for CR-HM-11.
Does not invent runtime.

## §1 Position in the frozen roadmap

Roadmap row 11: **BAST & Customer Acceptance**.

Scope vocabulary: *structured digital BAST; acceptance
evidence/signature; customer acceptance state*.

Primary authority: **Handyman-Backend**.

Depends on (roadmap): **CR-HM-08**.

Produces contract for: **CR-HM-15, CR-HM-17, CR-HM-18**.

Exit gate:
> Structured BAST and customer acceptance contracts published;
> COMPLETE != BAST Acceptance and Quotation Approval != BAST
> Acceptance verified.

Preserve (roadmap):

- COMPLETE != BAST Acceptance
- Quotation Approval != BAST Acceptance

CR-HM-10 is treated as a **READ-ONLY prerequisite** for this start
(certification already published). CR-HM-10 is not reopened, not
mutated, and does not own acceptance gating.

## §2 BASELINE (verified this start)

| Check | Result |
| --- | --- |
| `origin/main` | `f46b0e05ae15dd9d41cc42752011a004727ce6b8` |
| Session branch | `arena/01a0ed85-handyman-backend` |
| Branch based on that main | YES (`merge-base` ancestor OK; HEAD = `f46b0e0`) |
| CR-HM-08 (roadmap Depends On) | READ-ONLY consumer: session COMPLETE/CHECK_OUT ≠ acceptance |
| CR-HM-10 FINAL CERTIFICATION | READ-ONLY prerequisite: QC/defect/evidence sequenced truth only |
| CR-HM-06 quotation approval | READ-ONLY: approval ≠ BAST acceptance |
| FM/BE-22 BAST / Vendor BAST | NOT Handyman authority (firewall; no reuse as owner) |

## §3 FROZEN ownership

ONE authority: **CR-HM-11 / Handyman-Backend** owns Handyman
customer acceptance and the Handyman BAST document as the
transactional acceptance record for an execution scope.

| Surface | Owner | This CR |
| --- | --- | --- |
| Handyman BAST header + state | CR-HM-11 | AUTHORITY |
| Customer acceptance decision / sign-off | CR-HM-11 | AUTHORITY |
| Acceptance evidence/signature binding | CR-HM-11 | AUTHORITY |
| Work session COMPLETE / CHECK_OUT | CR-HM-08 | READ-ONLY |
| QC / defect / rectification / evidence records | CR-HM-10 | READ-ONLY |
| Quotation version + customer approval | CR-HM-06 | READ-ONLY |
| Authorized execution scope | CR-HM-06 | READ-ONLY TARGET |
| Service warranty start eligibility | CR-HM-15 | CONSUMER (later) |
| Customer transaction / payment | CR-HM-13 | NOT this CR |
| FM BE-22 BAST / legacy Vendor BAST | FM engineering ops | FIREWALL |

**FK discipline (frozen):** new FKs point to Handyman tables
(`handyman_execution_scopes`, optional read refs to sessions /
evidence records) and generic realm (`users`, `clients`) ONLY —
NEVER to FM `work_orders`, FM `bast_documents`, or Vendor BAST.

Infra reuse ≠ authority transfer. Shared document/storage primitives
may hold bytes; they never own BAST status.

## §4 TARGET + ACTOR

**TARGET:** one `HANDYMAN_EXECUTION_SCOPE` (CR-HM-06 AUTHORIZED
scope). BAST/acceptance never attaches to FM work order, request,
quotation header alone, or session row as owner.

**ACTOR (acceptance authority):** the customer (or customer-delegated
acceptor) bound to that scope's client. Crew Lead COMPLETE is
**never** customer acceptance. Caller-supplied "accepted=true"
without a governed transition is rejected.

Lead/provider may **issue** a BAST draft for customer decision.
Only the customer-side acceptor **accepts / rejects**.

## §5 Lifecycle (frozen — names only, no runtime)

Single authoritative Handyman BAST status column. Bounded:

```text
DRAFT          — issued / prepared; not customer-accepted
ISSUED         — presented to customer; awaiting decision
ACCEPTED       — customer accepted (terminal success for this BAST)
REJECTED       — customer rejected (rework/reissue path; not warranty start)
VOID           — superseded / withdrawn (not acceptance)
```

Customer acceptance **state** is the BAST status (or a 1:1 projection
of it). Sign-off records do **not** independently become truth.

Legal intent (guards, not APIs):

| Action | Meaning |
| --- | --- |
| ISSUE | DRAFT → ISSUED (Lead/system; scope bound) |
| ACCEPT | ISSUED → ACCEPTED (customer acceptor + evidence/signature) |
| REJECT | ISSUED → REJECTED (customer; reason required later) |
| VOID | DRAFT/ISSUED → VOID (issuer; never after ACCEPTED without a later CR) |

FROZEN separations:

```text
session COMPLETE     != BAST Acceptance     (CR-HM-08)
CHECK_OUT            != customer acceptance
Quotation Approval   != BAST Acceptance     (CR-HM-06)
QC PASS              != BAST Acceptance     (CR-HM-10)
FM BAST status       != Handyman BAST
```

CR-HM-11 **may consume** CR-HM-08 COMPLETE and CR-HM-10 QC/defect
read models as **gates it defines**. Those modules never write
acceptance. Gating policy (whether COMPLETE and/or QC PASS is
required before ISSUE/ACCEPT) is **owned here** and frozen in a
later PART — not invented as runtime in this start.

Warranty start after ACCEPTED is **CR-HM-15**, not this CR.

## §6 Minimum mapped BAST / acceptance seams

No broad audit. Only seams required to freeze this CR:

1. **CR-HM-08 session seam** — COMPLETE/CHECK_OUT publish field
   completion; CR-HM-11 reads; never maps COMPLETE → ACCEPTED.
2. **CR-HM-10 evidence/QC seam** — evidence records, QC outcomes,
   defect states are sequenced truth; CR-HM-11 binds them as
   acceptance **evidence references** without ownership transfer.
   WARRANTY/BAST remain out of CR-HM-10 vocabulary (already
   certified).
3. **CR-HM-06 approval seam** — quotation approval authorizes
   execution scope; it is not customer work acceptance.
4. **CR-HM-15 warranty seam (outbound)** — only `ACCEPTED` BAST
   may later start service warranty; not implemented here.
5. **CR-HM-17/18 presentation seam** — clients display/submit
   acceptance commands against published contracts only.
6. **FM BAST firewall** — BE-22 / Vendor BAST / Acceptance Sign-Off
   conflicts documented in cross-repo review are **out of this CR**.
   Handyman does not become FM BAST-01 and does not dual-write FM
   BAST status.

## §7 BLOCKERS

| ID | Blocker | Rule |
| --- | --- | --- |
| B1 | CR-HM-08 not treated as COMPLETE≠ACCEPT | STOP if session COMPLETE is used as acceptance |
| B2 | CR-HM-10 cert reopened or QC PASS used as BAST | STOP; CR-HM-10 is read-only sequenced truth |
| B3 | Quotation approval treated as BAST | STOP |
| B4 | FM/BE-22 BAST reused as Handyman authority | STOP |
| B5 | Runtime/migration/API in a governance PART | STOP |
| B6 | Warranty/payment/ledger implemented here | STOP (CR-HM-15 / 13) |
| B7 | Dual independent sign-off truth vs BAST status | STOP; sign-off is state-gated, not a second owner |

Non-blockers (explicitly deferred): FM BAST-01 consolidation,
vendor settlement COM-02, permit-to-BAST EXT-02, SaaS billing.

## §8 Smallest PART split

| PART | Name | Allowed | Forbidden |
| --- | --- | --- | --- |
| **00** | START GOVERNANCE (this document) | Freeze ownership/lifecycle/authority/blockers/split | Runtime, migration, API |
| **01** | BAST aggregate + transitions | Authoritative Handyman BAST row, status guards, ISSUE/VOID | Sign-off HTTP, warranty, FM sync |
| **02** | Customer acceptance / sign-off | State-gated ACCEPT/REJECT + signature/evidence bind | Payment, QC mutation, session mutation |
| **03** | Published read contract | Contracts for CR-HM-15/17/18; COMPLETE≠ACCEPT and Approval≠ACCEPT checks | New authority, FM projection as truth |

Do not start PART 01 until this START is committed on the assigned
branch. Do not merge PART 02 before PART 01 status authority exists.
Do not treat PART 03 as a second write path.

## §9 Out of scope

- No OpenAPI, no HTTP, no SQL, no tests in this PART.
- No FM BAST transition API, no legacy Vendor BAST projection.
- No customer ledger, no warranty claim engine, no pricing.

## Handoff

CR-HM-15 consumes **ACCEPTED** as the only eligibility for
workmanship/service warranty start. CR-HM-17/18 consume the
published BAST/acceptance read+command contracts. CR-HM-13 must
not infer payment from ACCEPTED without its own CR.

STOP after this governance PART.
