# CR-HM-TAX-INDONESIA-02 — PART 02A: PPN/DPP calculator

## Authority and boundaries

`calculateApprovedHandymanPpn` is a read-only internal adapter around a pure,
integer-arithmetic calculator. For standalone `BM_COMMISSION` it requires a
trusted authenticated actor with Finance read and Client reach. The adapter
resolves both exact 0495/0496 identity approvals and the 0497 PPN rule in **one
read-only repeatable-read snapshot**, then verifies the caller's IDs, versions,
SHA-256 digests and approval-decision IDs. A missing, ambiguous, unapproved,
stale, mismatched or unsupported input fails closed. The PPN rule must have been
approved by the actual tax-point instant and by the database read time; the two
identities must also have been approved and effective at that instant. Tax date
is an explicit Indonesian calendar date and must match the supplied zoned
tax-point instant in Asia/Jakarta. No rule is selected from PKP status alone.

The output is a deterministic immutable breakdown and checksum, with source,
DPP, rate, PPN, total, rule and both identity approvals/provenance. Its SHA-256
checksum is over UTF-8 `stableJson` of the breakdown body excluding the
`checksumAlgorithm` and `checksum` fields. It is not an
invoice, fiscal authorization, legal opinion, earned entitlement or settlement,
and performs no writes. It does not alter legacy calculations or invoice
monetary constraints. The supplied parties and case are **not** bound here to
an actual invoice, tenant, Building, contract or charge; output explicitly says
`CALLER_SUPPLIED_NOT_VERIFIED`. A downstream integration must independently
verify those relationships, eligibility and legal facts before any financial use.

0495 currently supports only a provider issuer and a verified BM beneficiary,
not a dedicated tenant/customer tax identity. `CUSTOMER_SERVICE_BILLING` is
therefore **blocked** with `HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE`, even
if a customer-context rule and BM identity have been approved: a BM is never
substituted for a customer. PART 02A-B adds a separately verified request-buyer
binding, but an approved buyer tax identity and taxpayer classification remain
missing; see `CR-HM-TAX-INDONESIA-02-PART-02A-B.md`. For the standalone BM calculation,
the BM is the supplier and issuer is the recipient; both require their own
approved 0495 identity under the same Client. This does not bind them to an
actual commission, Building or entitlement. Self supply and obvious
equal/legacy-equivalent tax identifiers are rejected.

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
The caller explicitly supplies the classification and applicability; both
identity snapshots must match. This narrow implementation conservatively
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
