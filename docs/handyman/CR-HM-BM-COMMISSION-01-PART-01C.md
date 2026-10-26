# CR-HM-BM-COMMISSION-01 — PART 01C

## Scope and contract

Migration `0494_handyman_distinct_bm_entitlements` adds an EARNED BM_FEE
variant for a verified `BM_LEGAL_COUNTERPARTY`. The server resolves the exact
Client, execution-scope Building, agreement/version, DEFAULT rule and term,
verification and 0493 coverage at the ledger transaction's posted instant.
It stores the counterparty, Building, verification, coverage ID and coverage
window alongside the existing immutable agreement/rule/term snapshots. Legacy
Client beneficiary IDs are null for this variant and are never populated with
an unrelated legal party. The existing one-fact-per-transaction/kind constraint
and append-only rules remain in force.

The financial transaction/client reads publish
`beneficiaryKind: 'BM_LEGAL_COUNTERPARTY'` and the distinct provenance, with
both legacy beneficiary fields explicitly null. Existing Client-beneficiary read shapes,
amounts, fact IDs, replay behavior and settled history are unchanged. Existing
facts do not need retroactive Building coverage. Replays and corrections of a
distinct fact use its original snapshots even after prospective coverage closure
or agreement supersession; they do not select a replacement beneficiary.

## Fail-closed boundaries

No tax calculation, payout, bank binding or new settlement authority is added.
The existing agreement-only BM fiscal profile is not known to belong to a
distinct counterparty: distinct EARNED derivation therefore rejects ledgers
with a configured tenant tax profile, and fiscal bases/documents cannot be
attached to a distinct entitlement. Commercial-only derivation is not fiscal
certification. PAYABLE, inclusion and SETTLED are blocked for the whole
transaction until dedicated distinct-BM fiscal, beneficiary-bank and
settlement rules exist.

Database checks apply to direct SQL as well as services. Non-financial,
immutable conflict claims serialize distinct earnings against settlement and
fiscal inserts, including stale `REPEATABLE READ` snapshots. They are created
only by new writes; migration 0494 does not backfill or alter legacy history.
A downgrade is refused once any distinct entitlement exists.

Focused coverage includes exact beneficiary/Building/version provenance,
sibling-Building and cross-Client isolation, missing/future coverage,
substitution and immutability, same-key concurrency, corrections after closure
and supersession, settlement/fiscal refusal and both race commit orders.
Legacy EARNED/SETTLED upgrade, replay and fiscal-settlement regressions remain
separate compatibility checks.
