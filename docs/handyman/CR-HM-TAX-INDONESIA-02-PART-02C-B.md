# PART 02C-B — Consolidated BM commission tax projection

## Contract and authority

`calculateHandymanBmCommissionTaxProjection(actor, input)` is exported from
`handyman-bm-tax-projection`. Its complete input is the same pinned 0500 case
used by the individual verified BM calculators:

```ts
{
  clientId, entitlementId,
  determination: { caseId, version, digest, decisionId, decisionDigest }
}
```

The active reader needs `handyman.finance.read` and access to the exact
Building. The input cannot override the beneficiary, source amount, tax date,
classification, applicability, rate, rule or rounding. Both tax treatments
in the independently approved case, and their underlying approvals, must be
current and valid for their respective tax points. The case may be approved
after those tax points, but identity and rule approvals must already have
existed at each tax point;
a future point is a forecast, not evidence that a taxable event occurred. See
PART 02C-A for maker/checker, evidence and versioning details.

The public function runs both existing verified calculators in **one active
`REPEATABLE READ READ ONLY` PostgreSQL transaction**. Each independently
re-resolves the same current 0500 determination, EARNED source and required
identities/rules; the projection compares their source, case and beneficiary
provenance before composing any amount. The internal snapshot helper rejects
weaker or read-write transactions and matching session defaults without an
active transaction. No entitlement, payable, settlement, invoice, tax ledger,
tax document, withholding certificate or payout is created or altered.
Existing legacy Client-beneficiary entitlements retain their original verified
beneficiary and are never relabeled.

## Composition and independent decisions

The output has the exact commission gross and both full verified calculator
breakdowns, plus `ppnBasis`, `ppnAmount`, `pphWithholdingBasis`, `pphWithheld`
and `netPayableProjection`. In canonical IDR decimal strings:

```
netPayableProjection = commissionGross + ppnAmount - pphWithheld
```

For rule-based treatments, the existing PPN and PPh calculators determine
their separate bases, rates, tax amounts and rounding. PPh uses its independently
approved gross or ratio method; PPN is **not** automatically included in the
PPh basis. The final addition/subtraction uses exact integer hundredths and adds no rounding
policy. For example, synthetic gross `10.00`, PPN `1.00`, and PPh `0.75`
produce `10.25`; these are test values, not statutory rates.

0500 originally had no literal `NOT_APPLICABLE` status. PART 02C-C adds an
explicit independently reviewed V2 treatment without changing 0500 history;
see `CR-HM-TAX-INDONESIA-02-PART-02C-C.md` for its distinct null-basis contract.
The existing zero-tax treatments remain PPN `EXEMPT` / `NON_TAXABLE` and PPh
`EXEMPT` / `NON_WITHHOLD`; none is inferred from another or from missing data.
PPN `EXEMPT` may still have a nonzero DPP, whereas `NON_TAXABLE` has zero DPP.
The supported PPh zero-withholding methods have zero withholding basis. A
missing, unapproved, ambiguous or unsupported rule never silently becomes
zero tax. PPN accepts only a whole-rupiah source ending in `.00`, even when
PPN is zero; a fractional source is rejected rather than rounded. Unsupported
rounding and an inexact `NO_ROUNDING` calculation also fail closed.

## Integrity and operational limits

The normalized input has its own SHA-256 checksum. The overall checksum is
SHA-256 of UTF-8 `stableJson` over the complete result body, excluding only the
outer `checksumAlgorithm` and `checksum` fields. It includes the normalized
input and input checksum, source/ledger/agreement/coverage anchors, independent
tax dates and treatments, approved identity and rule provenance, 0500 case
and checker decision pins, both component checksums, bases and amounts. The
same normalized pins and unchanged valid sources/approvals produce the same
result; a different reviewed case changes the checksums. No NPWP/NIK value or
uploaded evidence is returned.

Changed ledger facts, corrected entitlements, altered or mismatched
beneficiaries, stale cases, invalid evidence, ineffective approvals and rule
windows fail closed. Opaque non-placeholder evidence UUIDs do not prove that
an item exists or that its legal conclusion is correct; Finance must inspect
protected immutable external evidence. A consistent read can become stale
immediately after return. It is a calculation, not legal advice or authority
for a later financial write, and must be revalidated at any future posting
boundary. No rate or legal classification is seeded by this part.
