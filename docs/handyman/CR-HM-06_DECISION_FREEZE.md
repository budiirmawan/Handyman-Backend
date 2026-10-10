# CR-HM-06 — DECISION FREEZE (F1–F12)

**Status: FROZEN on 2026-09-27, base `97a4c1b`. F6 REVISED IN PART at v1.1 on 2026-10-10 — see the block under §F6; the original F6 text is preserved verbatim above it.** Docs-only freeze: NO
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


> **F6 — REVISED v1.1 (ratified 2026-10-10, W03 PART 03A).** The paragraph above is
> preserved **verbatim** for audit and is superseded **in part** — only its actor
> clause. Normative sources: `CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md`
> (A01 v1.1: amended F6 in §3, decisions A1–A9) and
> `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` (late Tenant PIC binding
> authority: B0–B20, revision R-1, maker-checker MC0–MC5').
>
> **What changed.** `Actor = authenticated local user with required Client/RBAC
> authority` becomes: the decision actor is a **Tenant PIC principal** admitted
> through a bounded, BM-attested PIC session, recorded explicitly and immutably as
> `decision_actor_type = 'TENANT_PIC'` with `decided_by_tenant_pic_id`,
> `decided_by_pic_session_id` and `approval_binding_id`. The approver may be
> conferred **after** intake and **before** presentation, through an audited,
> revocable, occupancy-verified **approval binding** on the quotation thread. No
> local `users` row, `user_sessions` row, role, or RBAC grant is required for or
> created by a PIC approver.
>
> **What does not change.** Explicitness; exactly one ISSUED version per decision;
> APPROVE | REJECT vocabulary; revision by new immutable version only;
> server-derived customer/request context; "caller-supplied customer identity is
> never authority" (a binding is an act of authority by a manager of that exact
> tenant and Building, never an identity claim inside the decide call); F7
> concurrency/idempotency; F8 APPROVE-only scope creation; F9 minimum authority;
> F10–F12 firewalls. A `USER`-class decision row may no longer be created — staff
> approval is not customer consent — while historical `USER` rows remain valid,
> readable, and never reinterpreted.
>
> **Tokens added by this revised freeze.** The Frozen-tokens table at the top of
> this file is **not** rewritten; the additions live here:
>
> | Token | Value |
> |---|---|
> | APPROVAL_ACTOR_CLASSES | TENANT_PIC (prospective) · USER (historical, read-only) |
> | PIC_APPROVAL_EXCLUSIVE | NEW USER-CLASS DECISION ROWS FORBIDDEN |
> | PIC_SESSION_CREDENTIAL | BOUNDED_ATTESTED_NO_LOCAL_USER |
> | MAKER_CHECKER_RULE | IDENTITY_EQUIVALENCE_NO_BORROW (maker set includes the binding granter) |
> | APPROVAL_BINDING_ANCHOR | QUOTATION_THREAD (never the request row, never a version row) |
> | APPROVAL_BINDING_LIFECYCLE | BIND_BEFORE_PRESENT · PIN_WHILE_ISSUED · REVOKE_ALWAYS · FROZEN_AFTER_DECISION |
> | APPROVAL_ANTI_FABRICATION | R-1: decision PIC = binding PIC; binding PIC = lineage PIC whenever the lineage names one |
> | EXECUTION_SCOPE_CREATION_ORIGIN | VALID_TENANT_PIC_APPROVAL_ONLY |
> | C6_AND_STAFF_BUILDING_SCOPE | NOT_EXTENDED |
> | LEDGER_CHANGE | ADDITIVE_ONLY_NO_BACKFILL_UPDATE |
>
> **Ratification is contract-level, not certification.** No implementation PART has
> started, and one P0 remains open and is reported here rather than smoothed over:
> **BLK-GAP-1** — approval continuity at cutover (the staff path may not be closed
> before the binding + PIC session paths ship). Owner: product owner + release
> manager; see ADD-A §8.

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

*v1.1 revision (2026-10-10): F6 actor clause revised in part by `CR-HM-06/A01` v1.1,
with `CR-HM-06_ADDENDUM_A_*` supplying the late Tenant PIC binding authority that
resolves F-06. Both are contract-level ratifications recorded in the same commit as
this file's change; no runtime, migration, OpenAPI, or test change accompanied them.*
