# CR-HM-13 PART 06 — Published Customer Transaction Ledger Read Contract

Status: PUBLISHED (PART 06). Authority law: FROZEN
`CR-HM-13_START_GOVERNANCE.md` §7/§8/§9/§10/§11.8, §13 row 06,
Handoff.

## 1. What is published

Module: `src/modules/handyman-customer-ledger-read/` — a READ-ONLY
composition over the PART 01–05 ledger facts (transaction, charge
lines + composition anchors, payments, allocations, corrections). It
owns no table, no vocabulary, no mutation, and no HTTP, and its ONLY
database access is a `SELECT` through the shared pool: the read
contract is structurally incapable of writing (B12 — never a second
write path).

| Function | Purpose | Primary consumer |
| --- | --- | --- |
| `readHandymanLedgerTransactionAt(executionScopeId, actorUserId)` | Full read-only composition of ONE ledger transaction: charge lines (LABOR/MATERIAL separate) with anchors, payments, allocations, ALL correction facts, and gross + net totals with the authority gate | CR-HM-14, CR-HM-17 |
| `readHandymanLedgerClientBasisAt(clientId, actorUserId, { from, to, limit })` | Bounded, windowed per-transaction NET basis for one client (default 200, max 500 ledgers), with aggregates and the authority gate | CR-HM-14, CR-HM-17 |

Every shape carries `contractVersion: 'CR-HM-13-PART-06'` and
`readOnly: true`.

## 2. Consumption rules (frozen)

1. **Net, never gross-only (§7.4).** Corrections (refund / reversal /
   adjustment) are published as facts AND netted into every net figure
   (`totals.*Net`, per-line `netAmount`/`applied`/`outstanding`,
   per-payment `applied`/`netReceived`). A consumer must use the net
   basis for entitlement derivation; gross figures are published only
   so the immutable posted facts stay machine-visible.
2. **Check the gate (§Handoff).** CR-HM-14 must not derive
   provider/BM entitlement unless
   `authority.authoritativeForEntitlement` is `true` (and, at the
   client level, the ledger is not listed in
   `nonAuthoritativeTransactionIds`). The flag is fail-closed: it is
   `false` while any PENDING payment intake is undecided
   (`PROVISIONAL_PAYMENTS_PENDING`) or while no charge facts exist
   (`NO_POSTED_CHARGE_FACTS`). Per-payment flags
   (`authoritativeForEntitlement`) are `CONFIRMED`-and-not-reversed
   only; PENDING/REJECTED intake is visible but never authoritative.
3. **LABOR and MATERIAL never merge (I13/B7).** Charge lines and the
   totals keep the two kinds separate; line-scoped adjustments are
   split per kind, and transaction-scoped adjustments are published
   only as `adjustedTransactionScope` — never smeared onto a line.
4. **Facts are read-only truth (I1/I12).** Allocation reversal is
   published as a flag plus the reversal fact; nothing is deleted,
   clamped, or restated. Any paid/outstanding figure is a projection
   over posted facts.
5. **Exact money only (I7).** Amounts cross this boundary as canonical
   decimal strings and are added/compared in integer cents; no float
   arithmetic exists in the contract.
6. **Bounded, authority-walled reads (§9.6).** Reads require an
   authenticated local actor with access to the owning client; unknown
   scope/ledger/client is a bounded 404, a foreign actor a bounded 403,
   and malformed window/limit input fails closed with a bounded 400 and
   performs no read. No caller-supplied money, status, or identity is
   ever accepted.
7. **Idempotency is not re-derived here.** Keys/effects belong to the
   PART 01–05 commands; the contract only reports their persisted
   facts.

## 3. What is deliberately NOT published here

- ANY write path: no posting, allocation, refund, reversal, adjustment,
  settlement, or second ledger module — the exports are reads only.
- Entitlement/fee derivation, settlement/reconciliation states,
  payouts (CR-HM-14), and any gateway/provider runtime or vocabulary.
- SaaS billing/subscription/pricebook/entitlement substrate and the FM
  financial legacy tables — zero read, zero write, zero FK (§10).
- HTTP/OpenAPI (PART 07 is conditional and never a second write path).
- Writes into CR-HM-06/09/11: approved snapshots, settled quantities,
  and BAST stay untouched.

## 4. Firewall verification (PART 06 law)

Enforced by `tests/handyman-ledger-read-contract.test.ts`:

1. published facts + gross/net totals + all three correction kinds +
   the authority gate on one ledger;
2. net-vs-gross reality: gross posted facts byte-stable, net figures
   independently recomputable by SQL, repeated reads identical;
3. fail-closed gate: PENDING intake blocks the shape, per-payment
   flags, empty-ledger `NO_POSTED_CHARGE_FACTS`;
4. client-level windowed basis: aggregates = exact sum of entries,
   window bounds, bounded 400/404/403 errors, no cross-client leakage,
   non-authoritative ledger IDs surfaced;
5. write-incapacity: frozen module surface, no mutation verb / DDL /
   transaction handle / command import in the source, every statement a
   `SELECT`, and the whole ledger byte-identical after the full read
   battery;
6. firewall + invariant battery: no SaaS/FM substrate token, FK, or
   column in the ledger, and I3/I4/I5/I6/I8/I9 fail closed at their
   exact boundaries while LABOR/MATERIAL stay separate in the
   published shape.
