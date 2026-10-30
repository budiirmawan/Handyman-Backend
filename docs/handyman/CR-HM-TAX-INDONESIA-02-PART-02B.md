# CR-HM-TAX-INDONESIA-02 — PART 02B: BM commission PPh projection

## Boundary and authority

PART 02C-A replaces the original caller-asserted BM adapter. The current
`calculateApprovedHandymanBmWithholding` accepts only Client/entitlement and a
current independently approved BM tax case pin; it does not accept a caller's
treatment, classification, amount or rule as calculation overrides. The
verified source, separate PPN/PPh approvals and exact case decision are
re-resolved in one read-only repeatable-read snapshot. See
`CR-HM-TAX-INDONESIA-02-PART-02C-A.md` for permissions, evidence, provenance,
versioning and the precise input contract.

`readHandymanBmCommissionSource(actor, { clientId, entitlementId })` still
reads and pins an existing immutable `BM_FEE` / `EARNED` fact; it does not
create one. The 02B pure core validates supplied snapshots and math but is
not a trusted authority adapter. Its `CALLER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED`
label applies only to that pure projection; the public BM boundary now
returns `INDEPENDENTLY_FINANCE_APPROVED` only after case verification.

Output is a read-only projection, never a payment or fiscal authorization.
No rate, residency, treatment, legal obligation or case is inferred. A qualified
Finance maker and separate checker must independently review each transaction
and each tax; opaque evidence references do not prove the evidence exists.

## Immutable source and replay

The source contains Client, Building, execution scope, transaction and
entitlement IDs; ledger contract/posting/derivation instants and derivation actor; gross and net
ledger components; original agreement/version/term and commercial rate; and
beneficiary, verification and Building coverage IDs. It checks the exact
commercial percentage against the stored gross using the existing commercial
half-up-to-cents rule. For an existing legacy fiscal basis, the pinned
immutable `basis_ex_vat` is used; otherwise the ledger labor net is used.
This is a check of the *commercial commission*, not a PPh assumption.

The current charge and commission-affecting adjustment facts are read in the
same snapshot, sorted by ID and fingerprinted; their net totals must equal the
immutable entitlement's original snapshot. Changed totals fail closed even if
the entitlement correction has not yet been written. An entitlement with any
separate correction/reversal is **unsupported**, rather than silently treating
the original fact as its current net. This part does not compute or persist a
corrected entitlement. Later ledger facts change the source checksum even if
their net effect is zero. A client must consciously obtain a fresh pin; an
older pin is rejected. Historical recalculation after a correction is not
provided by this read-only live-source adapter.

Distinct-BM facts must match all 0494 pinned beneficiary, verification,
coverage, Building and agreement anchors. Legacy `CLIENT_ORGANIZATION` facts
remain Client beneficiaries, and can be projected only if exact verified
Client-representing coverage existed by entitlement derivation and was
effective at posting. No coverage is inferred or backfilled for older facts.
The coverage is checked at the original posting, not reassigned to a different
BM effective at the later tax point. Prospective coverage closure or agreement
supersession does not alter the originally pinned fact; replay is identical as
long as the original coverage, tax identity and rule remain valid for their
respective instants and no relevant source changes occur.

SHA-256 uses UTF-8 `stableJson` (recursively sorted object keys, ordered
arrays). The source checksum covers the source body excluding its own
`checksumAlgorithm`/`checksum` fields; the result checksum follows the same
convention. The output also includes the ledger-basis digest, immutable
counterparty, verification and coverage anchor checksums, a commercial-anchor
checksum, the identity/rule snapshot digests and full independent approval
events. Anchor checksums bind the specified facts, not the complete underlying
commercial agreement. Registration and NPWP/NIK values are not returned.
These are integrity references, not a separate protected evidence store. A
read-only snapshot can become stale immediately after it is returned; it does
not lock, authorize or settle a later transaction.

## Finance-approved machine vocabulary

No legal source, rate, case or treatment is supplied by this change. Finance
must independently author, support and approve a 0497 rule. Unknown methods,
case descriptions, identity categories and rates fail closed. The explicit
classification is:

`P02B_{TAX|EXEMPT|NON_WITHHOLD}_{E|IR|IN}_{CASE}`

`E` is a legal entity, `IR` a resident individual and `IN` a non-resident
individual. `CASE` is an explicit Finance-defined case of 2–32 characters,
starting with a letter and containing uppercase letters, digits and single
underscores. Components `ANY`, `ALL`, `DEFAULT`, `UNKNOWN`, `UNSPECIFIED` and
`NONE` are forbidden. The rule's approved description must exactly be:

`P02B_V1|TREATMENT=<WITHHOLD|EXEMPT|NON_WITHHOLD>|BENEFICIARY=<ENTITY|INDIVIDUAL_RESIDENT|INDIVIDUAL_NON_RESIDENT>|CASE=<CASE>`

The input treatment and approved identity category must match. PKP is neither
used to pick a PPh treatment nor to infer withholding, although the existing
0496 identity approval requires the identity's PKP status to be known.

Supported rule `basisMethodCode` and exact `basisDescription` pairs are:

- `PPH02B_GROSS_V1`, positive configured rate:
  `P02B_V1|BASIS=GROSS|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH`
- `PPH02B_RATIO_N_D_V1`, positive configured rate and explicit ratio `N/D`:
  `P02B_V1|BASIS=ROUND(GROSS*N/D)|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH`
- `PPH02B_EXEMPT_V1`, exactly zero rate and `EXEMPT`:
  `P02B_V1|TREATMENT=EXEMPT|BASIS=0|PPH=0|NET=GROSS`
- `PPH02B_NON_WITHHOLD_V1`, exactly zero rate and `NON_WITHHOLD`:
  `P02B_V1|TREATMENT=NON_WITHHOLD|BASIS=0|PPH=0|NET=GROSS`

Replace N and D in both code and description with canonical integers in
1–1,000,000. A missing rule is never zero tax, and a zero-rate
`WITHHOLD` rule is rejected: exemption/non-withholding requires its own exact
independently approved case, method and zero rate. A positive rate may of
course round to zero for a sufficiently small commission.

All money is nonnegative canonical `NUMERIC(18,2)` text; BigInt and rational
arithmetic avoid floating-point loss. The existing earned commission can
contain fractional rupiah, so the calculator preserves its two stored decimal
places without asserting a legal currency precision. Finance must explicitly
approve `HALF_UP`, `HALF_EVEN`, `DOWN` or `UP` at scale 0 (whole rupiah) or 2
(stored hundredths); `NO_ROUNDING` requires null scale and exact results to a
stored hundredth. Ratio basis is rounded first, then withholding is rounded;
gross basis remains the exact stored gross before the withholding stage.
Inexact `NO_ROUNDING`, overflow, unsupported precision, non-IDR currencies,
negative projected net and inconsistent money are rejected. No rounding policy
is a default.
