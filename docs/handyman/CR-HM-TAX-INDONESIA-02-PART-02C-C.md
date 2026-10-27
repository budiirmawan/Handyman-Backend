# PART 02C-C — Explicit BM tax non-applicability

## Finance determination

Migration `0501_handyman_bm_tax_non_applicability` extends the existing 0500
case, maker/checker decision and source guards; it does not modify migration
0500 or rewrite any case, decision or financial fact. Existing rule-based
requests still produce the original V1 snapshots, results and checksums.
A case containing at least one explicit `NOT_APPLICABLE` treatment produces a
V2 snapshot. Rollback of 0501 refuses to discard support for populated V2
history; when no V2 case exists, it restores the 0500 guards.

The existing case proposal accepts the following alternative for either tax,
independently of the other:

```ts
ppn: {
  taxDate, taxPointAt, amountBasis: 'PPN_EXCLUSIVE',
  applicability: 'NOT_APPLICABLE', supplier, recipient,
  legalReference, legalSource, evidenceReferenceId
}
pph: {
  taxDate, taxPointAt, treatment: 'NOT_APPLICABLE', beneficiary,
  legalReference, legalSource, evidenceReferenceId
}
```

The other tax can instead use the unchanged approved-rule input. For an
explicit non-applicable tax, do **not** supply a rule, rule approval,
taxpayer classification, rate or rounding policy. A legal reference and its
source are required, each 4–512 characters, trimmed and non-placeholder;
the case's tax-specific evidence UUID is also mandatory. The current exact
EARNED entitlement, source checksum, Building, beneficiary, agreement and
separately dated, approved identities are still revalidated. Finance must
substantiate the precise legal conclusion: the text and opaque evidence UUID
are references, not proof of law, evidence existence or DJP registration.

An active scoped Finance maker proposes both treatments. A different scoped
checker with `handyman.bm_tax_case.approve` must approve the exact immutable
case and supply **separate PPN and PPh review evidence**. Self-approval,
pending, rejected, superseded, mismatched or changed approvals fail closed.
The case decision may follow the tax point; required identity approvals and
any rule approvals must already have existed at their respective tax points.
The case date and Jakarta tax-point instant are mandatory for each tax. A
future tax point remains a forecast.

## Calculation and provenance

The public verified BM PPN and PPh adapters and consolidated projection can
return `NOT_APPLICABLE` only from that independently approved, current case.
They return the explicit legal reference, source, evidence UUID, review UUID,
maker and checker, along with the case/decision digest and source provenance.
The tax amount is `0.00`; its rule, rate, rounding, classification and tax
basis are `null` because none was asserted. Accordingly `ppnBasis` or
`pphWithholdingBasis` is null in the consolidated result for that tax. TypeScript
consumers should narrow on `applicability` or `treatment` before accessing a
rule. The original rule-based result shape and checksum remain unchanged.

`NOT_APPLICABLE` is distinct from `EXEMPT`, `NON_TAXABLE`, `NON_WITHHOLD` and
zero-rated taxation. No zero rate or new legal policy is invented; literal
`ZERO_RATED` remains unsupported and fails closed. Missing, unknown,
ambiguous or unapproved rules never turn into `NOT_APPLICABLE`. The applicable
side still resolves and calculates its own approved rule. Net remains exact
commission gross + PPN − PPh, without adding PPN to the PPh basis. The existing
whole-rupiah PPN source safeguard remains in force even for `NOT_APPLICABLE`;
fractional-rupiah source amounts are rejected, not rounded.

All calculations remain read-only in one repeatable-read snapshot. They do
not authorize settlement, payout, invoice or any other financial write, and
may become stale immediately after returning. Revalidate at any later posting
boundary. No statutory rates or legal conclusions are seeded by this change.
