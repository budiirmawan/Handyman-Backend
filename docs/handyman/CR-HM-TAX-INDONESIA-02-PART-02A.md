# CR-HM-TAX-INDONESIA-02 — PART 02A: PPN/DPP calculator

## Authority and boundaries

`calculateApprovedHandymanPpn` is a read-only internal adapter around a pure,
integer-arithmetic calculator. As of PART 02C-A, BM commission PPN requires a
current independently approved, transaction-bound BM tax case. The adapter
re-resolves the exact entitlement, Building, beneficiary, both independently
approved tax rules and the required identities in one read-only repeatable-read
snapshot. The case maker, not the calculation caller, declares the PPN
classification and applicability. See `CR-HM-TAX-INDONESIA-02-PART-02C-A.md`
for the full authority, evidence and input contract. Unbound BM calls fail
closed.

The distinct customer path still requires the verified request-buyer binding
and reviewed customer classification described in PART 02A-B and 02A-C. It
does not assert that an invoice, ledger charge or payment exists. A missing
classification retains the customer-identity blocker. A BM is never
substituted for a customer.

Output is a deterministic immutable breakdown with approved-rule provenance
and a SHA-256 checksum over UTF-8 `stableJson` of its body, excluding checksum
fields. It is not an invoice, fiscal authorization, legal opinion, earned
entitlement or settlement, and performs no writes. Self supply and obvious
equal/legacy-equivalent taxpayer identifiers remain rejected. No rule is
selected from PKP status alone.

## Explicit rule vocabulary

No rates, rules or legal treatments are seeded. Finance must author and
independently approve a 0497 `PPN` rule with exact machine vocabulary, source,
legal reference and checker evidence. These are technical calculation contracts,
not Indonesian legal classifications or automatic verification of the law.
An existing arbitrary 0497 method/description is never reinterpreted.

The rule's `taxpayerClassification` must be
`P02A_{TAX|EXEMPT|NON_TAX}_{E|IR|IN}_{P|N}_{E|IR|IN}_{P|N}_{CASE}`.
The first taxpayer pair is supplier, the second recipient: `E` is a legal
entity, `IR`/`IN` are resident/non-resident individuals, and `P`/`N` are
PKP/non-PKP. `CASE` is a required, specific Finance-defined case code, not a
wildcard or inferred service classification. It is 2–32 characters, beginning
with a letter and containing uppercase letters, digits or single underscores;
`ANY`, `ALL`, `DEFAULT`, `UNKNOWN`, `UNSPECIFIED` and `NONE` are not allowed as
underscore-separated components. The approved `classificationDescription`
must exactly read `P02A_V1|APPLICABILITY=<TAXABLE|EXEMPT|NON_TAXABLE>|SUPPLIER=<ENTITY|INDIVIDUAL_RESIDENT|INDIVIDUAL_NON_RESIDENT>,<PKP|NON_PKP>|RECIPIENT=<same kind>,<PKP|NON_PKP>|CASE=<CASE>`.
The case maker explicitly declares the classification and applicability; both
identity snapshots must match and an independent checker must approve the BM case. This narrow implementation conservatively
requires a PKP supplier for `TAXABLE`; it does not conclude that NON_PKP implies
exemption or that PKP alone implies taxable treatment. Other scenarios need a
separately governed contract.

The only supported source is `PPN_EXCLUSIVE`. The approved basis code **and**
its exact approved description must match one of:

- `PPN02A_EXCLUSIVE_FULL_V1`: taxable, DPP = source. Description:
  `P02A_V1|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN`
- `PPN02A_EXCLUSIVE_RATIO_N_D_V1`: taxable, explicit positive integer ratio N/D. Description:
  `P02A_V1|SOURCE=EXCLUSIVE|DPP=ROUND(SOURCE*N/D)|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN`
- `PPN02A_EXEMPT_FULL_V1`: explicitly exempt, configured rate must be zero. Description:
  `P02A_V1|APPLICABILITY=EXEMPT|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=0|TOTAL=SOURCE`
- `PPN02A_NON_TAXABLE_V1`: explicitly non-taxable, configured rate must be zero. Description:
  `P02A_V1|APPLICABILITY=NON_TAXABLE|SOURCE=EXCLUSIVE|DPP=0|PPN=0|TOTAL=SOURCE`

Replace N and D with their actual canonical integers in **both** the code and
description; each is 1–1,000,000. DPP is rounded first and PPN is then
calculated from that rounded DPP; the approved rate is an exact percentage
string. `HALF_UP`, `HALF_EVEN`, `DOWN`, `UP` and exact `NO_ROUNDING` are
supported. Only `IDR` and whole rupiah (currency precision 0) are supported;
source and output use canonical `NUMERIC(18,2)` strings ending `.00`. Rounded
rules must explicitly specify scale 0; `NO_ROUNDING` requires a null scale and
fails if an intermediate is inexact. Negative amounts, FX, fractional rupiah,
other scales, inclusive prices, PPh and unrecognized methods fail closed.
No tax rate, exemption, ratio or rounding mode is a universal default.
