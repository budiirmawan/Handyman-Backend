# CR-HM-TAX-INDONESIA-01 — PART 01C: Finance-governed rule versions

## Contract and legal boundary

Migration 0497 adds an independent, Client-scoped rule registry. It does not
change invoice, fiscal, entitlement, settlement, identity or approval facts.
It enables no additional computation, invoice issuance, distinct-BM earnings
or settlement; all existing gates and legacy behavior remain unchanged.
There are no preloaded rules, rates, DPP methods or default exemptions.

The required, validated **internal family codes** are `PPN` and
`PPH_WITHHOLDING`; they are not declarations of a specific PPh article,
exemption or Indonesian legal classification. The transaction context is
exactly `CUSTOMER_SERVICE_BILLING` or `BM_COMMISSION`. A Finance author must
also explicitly supply a specific case/classification code and its written
definition, DPP/basis method code and description, exact decimal percentage,
rounding mode/scale, legal reference and source, and evidence provenance.
`UNKNOWN`, wildcard/default codes and standalone `PKP`/`NON_PKP` are rejected.
The percentage is a decimal string in percent, not a binary float; zero is
permitted only as an explicitly reviewed value, never as a missing-rule fallback.
These descriptive case and method identifiers are Finance-supplied internal
codes; software format checks do not independently establish their legal meaning
or prove that different case codes are mutually exclusive. Finance must validate
their definitions and applicability before choosing and approving a case.

A checker must explicitly attest `FINANCE_VALIDATED` and record independent
review evidence when approving. Finance is responsible for verifying the actual
legal source, its applicability and evidence outside this registry; a string,
URL, identity approval or system check does not establish authenticity, legal
correctness, DJP registration, or legal advice. No rule is seeded as legally
approved. Explicit tax context and classification are required even when a
0495/0496 identity is approved; the resolver never derives applicability from
that identity or its PKP status.

## Lifecycle and scope

- An active maker needs `handyman.finance.manage` and active Building reach to
  the exact provider Client. An active, different checker needs both
  `handyman.finance.read` and the deliberately unassigned-by-default
  `handyman.tax_rule.approve`, plus the same Client reach. The checker cannot
  be the version author or submitter. Trusted server callers provide the
  authenticated actor; a database actor ID alone is not authentication.
- A version is immutable and assigned monotonically per exact Client, context,
  tax code and taxpayer classification. The database rejects overlapping
  windows for that scope **even for drafts**, with a GiST exclusion constraint
  protecting concurrent and direct SQL writers. There is no cross-Client or
  cross-context fallback. Submit once; record one independent APPROVE or REJECT
  with actor, server time, source validation, evidence and the V1 SHA-256 digest
  of the exact immutable version. Duplicate decisions and changed review
  windows fail closed. Rejected versions require a new version.
- Dates are Indonesian calendar dates with `[effectiveFrom, effectiveTo)`
  boundaries; null end is open. A separate immutable closure may shorten a
  window only prospectively (after the current Jakarta date), or cancel a
  future rule at its start. It never rewrites the old rule, digest or approval.
  Supersession requires closing any open overlapping window first. A maker can
  close a rule, which only withdraws availability; a replacement still needs
  independent Finance approval. Rejection can close the review of a changed
  window but grants no authority.
- `resolveHandymanTaxRule` requires the exact Client, context, tax code,
  taxpayer classification and tax date. It returns `MISSING`, `AMBIGUOUS`,
  `NOT_APPROVED`, `INTEGRITY_ERROR`, or the unique intact `APPROVED` rule and
  pinned events. It does not decide whether that case applies or compute a tax.
  Approval must exist by the server read time (or optional earlier `knownAt`);
  a future `knownAt` never advances server time. Historic tax dates can be
  reviewed later, but the approval timestamp remains explicit and no historical
  financial fact is amended. Consumers must pin their actual decision and must
  not reconstruct old invoices or earnings from today's current rule lookup.

Rules and approval events cannot be updated or deleted; downgrade refuses to
remove populated history. Finance must separately provision checker authority
and validated sources before any rule can become approved. Further integration
and independent review are required before any tax calculation or tax-bearing
invoice issuance can use these definitions.
