# PART 02A-C — Customer tax-document classification

## Boundary and authority

Migration 0499 adds immutable, versioned classification assertions and
independent `VERIFY`/`REJECT` decisions. It reuses the current verified 0498
request-buyer binding and the approved 0497 PPN rule; it creates no customer or
supplier master. The buyer remains the bound Tenant party, not the request
creator, PIC, Care actor, provider Client or BM. Each assertion pins the exact
buyer binding and decision, buyer kind, rule version/digest and approval,
request/Client/Building, IDR amount/basis, Indonesian tax date/instant and
review evidence. A change to the bound buyer, amount, instant or applicable
rule fails closed and requires another reviewed version. The per-request head
serializes competing versions and decisions; populated history cannot be
rolled back.

An active Finance maker needs `handyman.finance.manage`,
`handyman.finance.read`, `handyman.customer_tax.read` and exact Building access.
A different active checker needs Finance read, `handyman.customer_tax.read`,
`handyman.tax_identity.approve` and the same Building access. The new
customer-tax capability is registered but **not assigned by default**, including
after foundation seeding. Read and calculator access also require this
capability, Finance read and exact Building reach. These are trusted internal
services; database credentials and external evidence storage still require
appropriate operational access controls.

No taxpayer number or scan is stored in 0499. Where the approved rule requires
an identifier, the maker supplies its kind and a UUID reference to an
**immutable, version-specific** external evidence item. Transaction, retail and
checker evidence are likewise opaque UUID references, not raw documents or
hashes of low-entropy taxpayer numbers. The checker must actually review the
referenced evidence, its connection to the bound buyer and the rule; a UUID is
not proof that evidence exists. This service does not fetch a vault, verify
registration with DJP, validate a document's digits, or prevent a deliberately
false Finance attestation. Deployments must provide protected immutable evidence
storage and an accountable review procedure before relying on these assertions.
NIK format alone does not establish NPWP matching or registration. No buyer PKP
or residency assertion is requested or inferred.

## Explicit approved policy

Nothing is seeded as a legal rule, rate, exception or applicable service. To
use this path, Finance must author and independently approve an exact 0497
`CUSTOMER_SERVICE_BILLING` / `PPN` rule, with applicable legal reference,
source, maker/checker evidence and `FINANCE_VALIDATED` source review. The
technical classification vocabulary is:

`P02AC_{TAX|EXEMPT|NON_TAX}_{E|IR|IN}_{P|N}_{I|E}_{ORD|FINAL}_{NP15|NP16|NIK16|NIKNP16|PASS|NONE}_{CASE}`

The first kind/PKP pair is the supplier (entity, resident individual or
non-resident individual); `I`/`E` is the bound individual/entity buyer. No
token asserts buyer PKP status. `ORD` is an ordinary
document policy and requires the identifier reference specified by that exact
rule. `FINAL` is a reviewed final-consumer policy; only it can specify `NONE`.
Identifier codes mean NPWP 15, NPWP 16, NIK 16, NIK explicitly reviewed as
NPWP 16, passport or no identifier respectively. A legal entity cannot use a
personal NIK or passport in this contract. Supporting an identifier kind does
not declare it legally sufficient: the approved rule and its evidence must
support that exact use. Other document paths fail closed. `CASE` is a specific
Finance-defined case, not a wildcard/default.

The 0497 classification description must match exactly:

`P02AC_V1|APPLICABILITY=<TAXABLE|EXEMPT|NON_TAXABLE>|SUPPLIER=<ENTITY|INDIVIDUAL_RESIDENT|INDIVIDUAL_NON_RESIDENT>,<PKP|NON_PKP>|BUYER=<INDIVIDUAL|LEGAL_ENTITY>|DOCUMENT=<ORDINARY|FINAL_CONSUMER>|IDENTIFIER=<NPWP_15|NPWP_16|NIK_16|NIK_NPWP_16|PASSPORT|NONE>|CASE=<CASE>`

`FINAL` does not follow merely from being an individual or having no NPWP. It
requires an independently reviewed assertion that the **seller qualifies** for
the approved retail rule, the transaction is direct retail, the buyer is the
final consumer and the transaction is not for resale, plus retail and
transaction evidence references. Finance must check any additional facts and
statutory conditions in the approved rule and legal source. Any false/unknown
flag, absent evidence, unapproved rule, mismatched buyer kind or ID, or stale
source blocks use; these checks are conservative and do not claim to cover all
legally possible exceptions. Distinct supplier/buyer status is also explicitly
attested; opaque references do not permit automatic taxpayer-number comparison.

## Read-only calculator

`calculateApprovedHandymanPpn` can now return a customer breakdown only after
re-resolving the reviewed classification, current buyer, separately approved
provider issuer and exact approved rule in one read-only repeatable-read
snapshot. It reuses PART 02A's supported method/rounding vocabulary and the
rule's existing rate; no rate or tax treatment is invented. The breakdown
contains immutable pins and review references but omits the buyer identifier
reference and number. It labels the source as a Finance-reviewed transaction
assertion, **not** a verified invoice, ledger entry or payment. A missing
classification retains the earlier customer-identity blocker. No invoice or
fiscal document can be issued by this calculation; existing BM calculations
and entitlement/settlement facts are unchanged.
