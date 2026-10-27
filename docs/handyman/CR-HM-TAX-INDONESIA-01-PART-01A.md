# CR-HM-TAX-INDONESIA-01 — PART 01A: tax identity and PKP profile

> Historical PART 01A contract. PART 01B adds separate Finance approval facts;
> see `CR-HM-TAX-INDONESIA-01-PART-01B.md`. The 0495 assertion itself and its
> `UNAPPROVED` snapshot field remain immutable and are not rewritten.

## Scope and authority

Migration 0495 adds **assertions**, not another issuer, BM party, tax engine, or
approval system. An issuer assertion belongs to the provider Client and names
one exact 0490 issuer-profile version. A BM assertion belongs to one exact
Client-scoped 0493 legal counterparty and its immutable verification. The legal
name must match that existing anchor. A BM assertion cannot begin before the BM
verification; an issuer assertion cannot begin before its issuer version. No
identity, Building coverage, tax status, or identifier is inferred or
backfilled from existing commercial or financial records.

This is an internal service contract, not a new HTTP endpoint. Capture and
closure require explicit `handyman.finance.manage`; reading and resolving
require explicit `handyman.finance.read`. Both also require access to the
provider Client through an existing active Building assignment. BM identity is
Client-scoped master data, not a Building coverage grant: the exact 0493/0494
Building, agreement and beneficiary requirements remain separate and unchanged.
No permission is created or granted to a role.

**PART 01A limitation, superseded by PART 01B:** commercial authority,
agreement tax-fact preparation, and 0493 BM legal-party verification are not
Finance tax approval. The 0495 assertion permanently remains
`approval_status = UNAPPROVED`, and `resolveHandymanTaxIdentityAt` still returns
`taxUse.allowed = false`. PART 01B adds independent, digest-pinned Finance
maker-checker events and the separately gated `requireApprovedHandymanTaxIdentityAt`.
Neither part enables tax calculation, fiscal documents, Coretax, tax-configured
distinct-BM earnings, or distinct-BM settlement.

## Identifier contract

Taxpayer kind is `UNKNOWN`, `LEGAL_ENTITY`, or `INDIVIDUAL`; individuals also
explicitly declare `RESIDENT`, `NON_RESIDENT`, or `UNKNOWN` residency. Missing
classification is never guessed. Supported identifier **shapes**, enforced in
both service and database, are:

| Identifier kind | Permitted assertion | Input/storage |
| --- | --- | --- |
| `NPWP_15` | historical 15-digit NPWP for any supported taxpayer kind | 15 digits or `99.999.999.9-999.999`; stored as 15 digits |
| `NPWP_16` | legal entity or non-resident individual | 16 digits |
| `NIK_NPWP_16` | resident individual declaring NIK as NPWP | 16 digits |

All-zero identifiers are rejected. `UNKNOWN` PKP may omit the identifier;
claiming `PKP` or `NON_PKP` requires one. Unknown taxpayer type cannot claim a
known PKP status. Unknown individual residency remains unapproved and
unusable. These are deliberately bounded shapes, **not** proof of identity,
residency, tax registration, DJP matching, PKP status, legal validity for a
particular tax period, or conversion between 15 and 16 digits. NITKU and other
identifier categories are not implemented. The DJP describes NIK as NPWP for
resident individuals and 16-digit NPWP for non-resident individuals and legal
entities [13](https://pajak.go.id/en/node/108460), as well as the transitional
use of 15-digit NPWP [9](https://www.pajak.go.id/index.php/en/node/110183).

## Effective history and snapshots

- Inputs are strict timezone-qualified timestamps with at most millisecond
  precision; windows are half-open `[effectiveFrom, effectiveTo)` and may be
  open-ended. One owner cannot have overlapping windows, even across issuer
  versions or concurrent transactions. The service uses an expected version,
  owner lock, and actor-bound idempotency key; database constraints, immutable
  facts, a unique version, and a GiST exclusion also protect direct SQL and
  repeatable-read races.
- Profile rows are immutable. The sole closure is an immutable event with
  server-recorded time, actor, and reason; a guarded range table is its
  projection. A closure may shorten an existing window prospectively. Setting
  `effectiveTo` equal to `effectiveFrom` cancels a future assertion only before
  it begins. It remains in version history, and a replacement can start at the
  same instant. A Finance reader can list the bounded, version-paginated
  history including cancelled assertions. Neither operation rewrites prior
  financial facts.
- Resolution requires exact Client, owner and as-of instant; it does not fall
  back to the provider, another BM, the coarse 0490 tax ID, or another version.
  An issuer snapshot cannot resolve past the referenced 0490 version's
  supersession. `effectiveWindow.to` is the earlier of the tax-window end and
  issuer supersession; both underlying boundaries are also returned.
- The frozen `HANDYMAN_TAX_IDENTITY_V1` snapshot is the immutable asserted
  profile including exact anchor IDs, identifier, taxpayer/PKP claims, declared
  effective end, evidence source/reference, actor and server creation time.
  Its SHA-256 is computed over UTF-8 `stableJson(snapshot)` (recursive sorted
  keys). This V1 payload and algorithm are a permanent contract. Later closure
  events and the current window projection are deliberately outside the digest,
  so a historical snapshot digest does not change when a window closes. A
  consumer must pin the snapshot and digest, not treat that digest as approval.
- `evidenceReference` is a reference, not an uploaded document. The returned
  snapshot contains sensitive tax identifiers and must remain within the
  authorized Finance boundary; the digest is not a substitute for secrecy.
  Downgrade refuses to delete populated identity history.
