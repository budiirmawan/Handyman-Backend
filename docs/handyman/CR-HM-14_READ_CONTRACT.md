# CR-HM-14 PART 04 — Published financial read contract

Status: PUBLISHED. Authority: `CR-HM-14_START_GOVERNANCE.md` §8–§10,
§14 PART 04. Internal module: `src/modules/handyman-financial-read/`.
No HTTP/OpenAPI, mutation verb, transaction handle, new financial authority,
or external statement/payout input is published.

## Exports

- `readHandymanFinancialTransactionAt(executionScopeId, actorUserId)`:
  exact, actor/client-walled ledger transaction with its CR-HM-14
  entitlement facts and forward corrections; immutable settlement unit,
  ordered lifecycle events, inclusions, all reconciliation runs (and
  latest result), and visible forward exception facts.
- `readHandymanFinancialClientAt(clientId, actorUserId, {from,to,limit})`:
  actor/client-walled windowed entries. Validation and bounds are the
  *published* CR-HM-13 PART 06 contract (default 200, maximum 500);
  non-authoritative transaction IDs are explicitly excluded from this
  read's entries. The client-level authority and excluded IDs remain
  visible; **there is no aggregate that silently includes excluded
  entries**.

Both return `contractVersion: 'CR-HM-14-PART-04'`,
`ledgerContractVersion: 'CR-HM-13-PART-06'` and `readOnly: true`.
The exact read retains historical facts even if the ledger has since
become non-authoritative; `status: LEDGER_NOT_AUTHORITATIVE` and the
CR-HM-13 `authority.deniedBy` make that posture explicit. Neither read
turns a denied ledger or a provisional payment into an entitlement.
Unknown/foreign scope and client, malformed UUID/window/limit, and
actor access refusals remain the bounded 404/403/400 of CR-HM-13's
published read contract; this module provides no alternate lookup.

## Fact and readiness semantics

- Entitlement `amount` is the **immutable EARNED amount**; each PART 02
  correction is a separate fact with its exact ledger cause ID and
  direction kind. No silent rewrite, proration, or fresh fee evaluation.
  Provider attribution anchors (assignment/context/crew/Lead) and BM
  exact-version binding (window, rule, term, rate, explicit beneficiary)
  are carried through verbatim.
- `netBasis` fields (`chargedNet`, `laborNet`, `materialNet`, `applied`,
  `netReceived`, `outstanding`) are **directly published CR-HM-13 net
  strings**, not gross amounts or a new financial computation. No
  JavaScript number represents a monetary field: SQL NUMERIC is cast
  to TEXT before fact serialization.
- `settlement.recordedState` is the highest *posted event*
  (`PAYABLE`, `INCLUDED_IN_SETTLEMENT`, `SETTLED`), or `NOT_RECORDED`.
  `SETTLED` remains terminal even when a later exception or variance
  appears. `settlement.latestReconciliation` is the last persisted
  reconciliation sequence, not an inferred outcome.
- Closed informational `status`: `LEDGER_NOT_AUTHORITATIVE`,
  `ENTITLEMENT_FACTS_MISSING`, `EARNED`, `PAYABLE`,
  `INCLUDED_IN_SETTLEMENT`, `SETTLED`, `EXCEPTION_RECORDED`,
  `RECONCILIATION_VARIANCE`. It is **not** an eligibility decision or
  permission to include/settle; PART 02/03 commands recheck authority,
  corrected entitlement facts, funding, exceptions and exactness under
  their own transaction locks. `EXCEPTION_RECORDED` or a variance may
  coexist with an immutable historical `SETTLED` event; no re-open is
  inferred. Disputes have no clearing/adjudication workflow in this CR.
- External evidence, if recorded elsewhere, is **evidence only**. No
  external statement, caller-provided money/state, bank identity,
  gateway result or SaaS/FM state enters either read's authority.

## Firewall and verification

The read repository performs one SELECT over CR-HM-14-owned fact tables
per bounded request (one PostgreSQL snapshot). The only ledger accesses
are the two read-only CR-HM-13 PART 06 exports. Its barrel exports no
repository, writer, transaction handle, HTTP or API. The PART 04 focused
suite proves the published shapes, correction and terminal history,
authority denial and non-authoritative exclusion, bounded 400/403/404,
no-SaaS/FM/gateway imports/SQL, SELECT-only DB access, and whole-table
byte-stability across repeated reads. No new table or migration is
introduced in PART 04.
