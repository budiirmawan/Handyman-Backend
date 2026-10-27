# PART 02A-B — Request buyer / tax-party boundary

## Contract

Migration 0498 adds request-scoped, append-only buyer assertions and
independent verification decisions; it creates **no customer master** and does
not backfill existing requests or financial records. `tenant_companies` is the
existing physical-party master for both `INDIVIDUAL` and `LEGAL_ENTITY`. A
buyer must be an active, `VERIFIED`, same-Client Tenant party with an explicit
legal name (the individual's name or the entity's `legal_name`). NPWP, NIK,
residency, PKP, customer login and a PIC login are **not** prerequisites for
this binding.

The caller explicitly selects the buyer, never the PIC, request creator,
Customer Care actor, consent actor, BM beneficiary or issuer by default. The
party must either be the request's represented Tenant, or have an effective
Owner/Occupant role on the exact Unit. A Unit PIC alone is not sufficient; it
may be selected only with an existing explicit `COST_RESPONSIBILITY`
designation. Any such designation must agree with the selected buyer. For an
unlisted-conversion request, the case's cost-responsible party and conversion
anchor must also agree. The resolver verifies the request's attribution or
manual-case provenance, Client, Property, Building, Unit and PIC scope. A BM
counterparty reference cannot stand in for a Tenant-party buyer, including an
ambiguous identical UUID. A person/entity that genuinely has both roles still
requires a separate, explicit Tenant-party designation and review.

The immutable scalar snapshot records the exact request/location, buyer and
master fingerprint, request creator, represented Tenant, PIC, Care actor,
optional cost designation and evidence. These are separate fields; the
snapshot says `consentAuthority: NOT_ASSERTED` and does not authorize a
quotation decision. The master fingerprint is an integrity checksum, **not**
anonymization or government validation; raw identity-document numbers are
not copied into the binding output.

## Verification and staleness

`proposeHandymanBuyerBinding` requires an active actor with
`handyman.finance.manage` and access to the exact request Building. It records
an immutable version with evidence. `decideHandymanBuyerBinding` requires a
different active actor with `handyman.finance.read`,
`handyman.tax_identity.approve` and the same exact Building access; it records
`VERIFY` or `REJECT` with its own evidence, server time and SHA-256. The
capability already exists and remains unassigned by default. Verification is
an explicit Finance assertion about the buyer and relationship; neither
0457's legacy-default `VERIFIED` flag nor this workflow proves government
registration, tax registration, PKP, residency, consent or legal applicability.
No evidence provider is contacted automatically.

`requireVerifiedHandymanBuyerBinding` requires request/Client, a zoned instant,
and exact binding ID/version/digest plus decision ID/digest. Verification must
already have occurred by both that instant and database read time. It rejects
missing, rejected, unverified, conflicting, tampered or superseded facts;
changes to the buyer's identity data, request provenance, cost designation or
Unit relationship also make the snapshot stale. Unit-role windows must cover
the requested instant. Earlier snapshots and decisions remain immutable; a new
version immediately supersedes the old one and requires its own independent
verification. The protected request head serializes revisions and decisions,
including fixed-snapshot races. Rollback refuses populated buyer history.
This resolver returns the **current** verified version; old facts are retained
for later governed historical snapshot/replay work, not silently reused.

## PPN boundary

For `CUSTOMER_SERVICE_BILLING`, the calculator accepts a request ID and exact
verified buyer-binding pin instead of a fabricated BM recipient. It resolves
the buyer and the independently approved 0495/0496 provider issuer in the
same read-only repeatable-read snapshot and enforces their separate scope and
pins. A buyer binding does **not** establish the 0497 recipient's taxpayer
classification, residency or PKP status. Because 0495 has no approved customer
tax-identity owner, the calculation then fails closed with
`HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE`; no PPN, exemption or tax invoice
is inferred. Enabling customer calculations needs a separately governed buyer
tax-identity contract and Finance-approved applicable rule. Existing standalone
BM calculations remain unchanged and unbound to an actual entitlement.

There is no invoice issuance, posting, settlement, new rate or tax rule, or
change to historic invoice, quotation, request or BM entitlement facts.
