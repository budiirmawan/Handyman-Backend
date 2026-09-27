# CR-HM-06 — DECISION FREEZE (F1–F12)

**Status: FROZEN on 2026-09-27, base `97a4c1b`.** Docs-only freeze: NO
runtime, NO migration, NO tests, NO OpenAPI, NO roadmap change.
Authoritative inputs: `CR-HM-06_START_GOVERNANCE.md`, frozen roadmap
CR-HM-06 row, `CR-HM-04_PART04_ASSIGNMENT_BOUNDARY.md` (FROZEN),
`CR-HM-05_PART05_TARGET_BINDING_CONTRACT.md` (FROZEN).

## Frozen tokens

| Token | Value |
|---|---|
| QUOTATION_AUTHORITY | HANDYMAN |
| VERSION_MUTATION | FORBIDDEN_AFTER_DECISION |
| CUSTOMER_APPROVAL | EXPLICIT_VERSION_BOUND |
| EXECUTION_SCOPE_CREATION | APPROVAL_ONLY |
| EXECUTION_SCOPE_PER_APPROVED_VERSION | ONE |
| CR_HM_12_PRICING_RULE_AUTHORITY | PRESERVED |
| FM_WORK_ORDER_REUSE | FORBIDDEN |
| BAST_ACCEPTANCE_SEPARATE | YES |
| PAYMENT_SEPARATE | YES |

## F1 — Quotation authority

Handyman owns its quotation / version / line snapshots end to end.
`vendor-quotations` (RFQ/vendor procurement) and any FM quotation
runtime are **pattern-only**, never authority and never substrate.

## F2 — Versioning

Quotation revisions are **immutable versions**. APPROVED / REJECTED /
EXPIRED / SUPERSEDED versions are **never rewritten**. A revision
creates a **new version**; it never mutates an earlier version's facts.

## F3 — Lifecycle

Exactly:

```
DRAFT → ISSUED → APPROVED | REJECTED | EXPIRED | SUPERSEDED
```

Only transitions actually valid for version semantics may be
implemented (draft editing; issue presents; decision/expiry/supersede
terminal-per-version). NO FM/procurement lifecycle states (no
WITHDRAWN, no vendor-side vocabulary).

## F4 — Commercial snapshot

Quotation separates **LABOR** and **MATERIAL** lines. Each line
snapshots at minimum: description/scope, quantity, UOM, reference
amount (when available), final quoted unit amount, line total,
currency. Approved commercial facts are **immutable**.
**Catalogue/reference price != final quoted amount.** No tax/discount
until an authoritative rule exists (none at freeze).

## F5 — CR-HM-12 firewall

CR-HM-06 may persist **bounded quotation snapshots**. CR-HM-12 remains
authority for: pricing rules/modes, commercial agreements, BM fee
rules, future governed pricing calculations. CR-HM-06 must not invent
those rules; governed lookups/reference prices are inputs only.

## F6 — Customer approval

The decision is **explicit** and bound to exactly **one ISSUED
quotation version**. Decision vocabulary: **APPROVE | REJECT**. A
revision request is represented through creation of a **new immutable
quotation version** — never mutation of the decided version. Actor =
authenticated local user with required Client/RBAC authority;
customer/request context is **server-derived**; caller-supplied
customer identity is **never authority**.

## F7 — Concurrency / idempotency

Approval/rejection must: lock the exact quotation version
(`lockById`-family convention) before decision evaluation; be
idempotent/replay-safe using the existing repo convention
(`idempotencyKey`/fingerprint); allow only **one authoritative
decision per version**; reject conflicting replay/decision.

## F8 — Execution Scope creation

Execution Scope is created **ONLY by successful APPROVE**. Approval
record + Execution Scope creation are **atomic** (one
`withTransaction`). REJECT never creates an Execution Scope. No
pre-approval placeholder scope (`PLACEHOLDER_TARGET=FORBIDDEN` stays).

## F9 — Execution Scope uniqueness & minimum authority

Exactly **one** authoritative Execution Scope per approved quotation
version. Minimum authority: id; clientId; request/channel lineage;
approved quotationVersionId; authoritative location snapshot; bounded
state sufficient for downstream assignment/scheduling;
createdByUserId; server timestamps. Do NOT invent field
execution/session states here.

## F10 — Downstream authority boundary

The Execution Scope becomes the legitimate target for: **CR-HM-04**
provider-authored crew assignment binding; **CR-HM-05** target-bound
scheduling; **CR-HM-07** expected-location / arrival verification;
**CR-HM-08** field execution anchor. CR-HM-06 does NOT implement those
downstream runtimes (frozen CR-HM-04 PART 04 §2 deferral and CR-HM-05
PART 05 §10 activation rule remain in force and unchanged).

## F11 — BAST / payment firewall

Quotation approval != BAST/customer service acceptance (CR-HM-11);
!= payment; != settlement (CR-HM-13); != work completion (CR-HM-08/10).

## F12 — FM firewall

Execution Scope != FM work_order. NO FM WO creation/reuse/conversion.
NO FM quotation lifecycle adoption. NO FM scheduling/permit runtime
(adopted or reused).

## Implementation part sequence (bounded, in order)

| PART | Scope | Rule |
|---|---|---|
| 01 | Quotation Foundation & Immutable Versions | F1–F4 groundwork; no lines beyond foundation contract |
| 02 | Labor / Material Commercial Snapshot Lines | F4 line snapshots; labor/material separation |
| 03 | Issue / Expiry / Revision Lifecycle | F2/F3 transitions only |
| 04 | Customer Approval / Rejection | F6/F7; decision record; NO approval-side scope yet |
| 05 | Execution Scope Creation | F8/F9; atomic with APPROVE |
| 06 | Downstream Binding Readiness Contract | F10 contract-shape/doc; not downstream runtime |
| 07A | HTTP + OpenAPI | PART 01–05 implemented surfaces only; F11/F12 parity |
| 07B | Final Validation / Certification | certification only |

Each PART stays bounded; later PARTs must not be implemented early;
the frozen roadmap order (CR-HM-02/03 → CR-HM-06 → CR-HM-05/07/…) is
not resequenced.

## Carried observation (CR-HM-05, non-binding)

The `operational_events` same-transaction timestamp + UUID tie-break
ordering flake (P02/P03 atomicity tests) remains **non-blocking
hardening debt** and is **NOT part of CR-HM-06 implementation scope**.
New CR-HM-06 surfaces must resolve journal rows deterministically
(`event_type`/`entity_id`) from inception rather than relying on
timestamp ordering.

---
*This freeze governs CR-HM-06 parts 01–07B only; any deviation requires
an explicit revised freeze before implementation.*
