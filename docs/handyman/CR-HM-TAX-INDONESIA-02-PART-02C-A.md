# PART 02C-A — Independently reviewed BM commission tax case

## Scope and authority

Migration `0500_handyman_bm_commission_tax_cases` adds an immutable, versioned
Finance determination and independent `APPROVE`/`REJECT` decision for one
existing `BM_FEE` / `EARNED` entitlement. It creates no entitlement, payable,
settlement, invoice, withholding certificate or payout, and does not weaken
0494's distinct-BM fiscal/settlement guards. No statutory rate, legal
classification or applicability is inferred or seeded.

`readHandymanBmCommissionSource(actor, { clientId, entitlementId })` first
returns the exact verified source and checksum. `proposeHandymanBmTaxCase`
requires that pin, declared transaction/service classifications and evidence,
plus separate PPN and PPh tax dates, zoned tax points, treatments,
classifications, evidence and exact previously approved identity/rule pins.
PPN's supplier is the exact BM beneficiary and its recipient is the Handyman
issuer. PPh independently pins the same verified BM beneficiary. The original
Client, Building, ledger, agreement/version, coverage and verified counterparty
are derived from the source, never chosen by the caller.

An active maker requires `handyman.finance.read`, `handyman.finance.manage`
and exact Building access. A **different** active checker requires Finance
read, `handyman.bm_tax_case.approve` and access to that same Building. The
checker explicitly reviews each tax and supplies separate review evidence
references. The dedicated checker permission is unassigned by default,
including to platform administrators. Finance must make each legal
applicability decision; one tax's treatment does not imply the other. The
separate 0496 identity and 0497 rule approvals must predate their respective
tax points and the read; a case review may occur later than the tax point,
but must be committed and no later than the read time. A future tax point is
only a forecast, not proof that a taxable event occurred.

Evidence references are opaque, non-placeholder UUIDs, not proof that an item
exists or that a legal conclusion is correct. Finance must actually examine
version-specific transaction, PPN and PPh evidence in protected immutable
external storage and use an accountable review process. This module neither
fetches a vault nor validates DJP registration. It stores no taxpayer number or
uploaded document. The reviewed assertion is not a legal opinion.

## Versioning and calculation

The maker supplies `expectedVersion: null` for the first version, or the
current integer version for a replacement, and an idempotency key. No new
version is accepted while the current one is pending. A rejected case is never
authority. Reusing the same key and payload returns the immutable historical
record with `replayed: true`; changed payloads conflict. An old or replayed
record does not bypass the current head, approval or stale-source checks.

For either BM calculator, the complete input is:

```ts
{
  clientId, entitlementId,
  determination: { caseId, version, digest, decisionId, decisionDigest }
}
```

`calculateApprovedHandymanPpn` and `calculateApprovedHandymanBmWithholding`
re-resolve the current approved case, exact source, both independently approved
rules and all required identities in one `REPEATABLE READ READ ONLY` snapshot.
The checker identity, decision time, case/version, both SHA-256 digests,
transaction/service classifications and source provenance are included in the
result checksum. Callers cannot supply or override an applicability,
classification, rate, amount or tax point at calculation. Legacy unbound BM
calculator calls fail closed. The separate reviewed-customer PPN path is
unchanged.

The PPN and PPh policies and machine vocabulary remain those documented in
PART 02A and 02B. Case approval validates both policies without doing monetary
rounding. PPh preserves an existing fractional commission, while actual PPN
calculation still rejects a source not ending in `.00`; it never silently
rounds the source. No missing rule becomes zero tax. Cases with stale ledger
facts, corrected entitlements, changed current head, wrong Client/Building,
incorrect beneficiary, invalid evidence or no longer effective identities or
rules cannot calculate. Original valid legacy Client-beneficiary coverage is
preserved and never relabeled.

Case and decision hashes use UTF-8 SHA-256 over `stableJson` of their bodies;
the decision body excludes its `decisionDigest` and response-only `replayed`
flag. Version history and decisions are immutable; rollback refuses populated
history. Writes use READ COMMITTED and serialize on the ledger row before the
case head, then share-lock identity/rule windows and the issuer lifecycle row
and revalidate. Direct BM entitlement correction inserts also serialize on the
ledger row. A read-only
snapshot can become stale immediately after it returns: it is not a lock or an
authorization for a later financial write. Tests use synthetic rates only.
