# CR-HM-TAX-INDONESIA-01 — PART 01B: Finance identity approval

## Authority and scope

Migration 0496 adds Finance approval **events**, not tax rates, calculations,
fiscal documents, bank payout, or settlement. The 0495 profile, its
`approvalStatus: UNAPPROVED`, and its `HANDYMAN_TAX_IDENTITY_V1` SHA-256 digest
are never rewritten. Approval is a separate attestation on the exact provider
Client, issuer or BM beneficiary, profile ID, version, and digest.

The internal service requires an authenticated, active user ID supplied by the
trusted caller. A maker needs `handyman.finance.manage`; a checker needs both
`handyman.finance.read` and the new `handyman.tax_identity.approve`. Both need
0495's explicit provider-Client reach through an active Building assignment.
The checker must differ from **both** the profile creator and submitter, even
when one user holds all capabilities; the same rule applies to rejection. No
role, including PLATFORM_ADMIN, receives the checker capability automatically.
An authorized administrator must deliberately grant it to an independent
Finance checker. Commercial, BM verification and settlement permissions do
not confer approval authority.

## Lifecycle

- A complete, non-UNKNOWN identity with identifier, PKP classification,
  evidence, exact existing issuer/verified BM anchor and a live or future
  effective window can be submitted once per profile. The maker supplies the
  exact profile version and V1 digest, plus submission evidence source and
  reference. The server pins the currently reviewed window.
- One distinct checker can append exactly one `APPROVE` or `REJECT`, with its
  own evidence, actor and server-set timestamp. Duplicate submissions or
  decisions fail closed. A rejected or stale submission is not reopened; a
  corrected assertion requires a new profile version and its own submission.
  Rejection may close a stale or expired submission but cannot grant authority.
- Approval requires the latest profile version at decision time, the exact
  submitted digest and unchanged reviewed window, complete evidence, a still
  valid period, and the current issuer or exact verified BM. Cancelled,
  expired, substituted, stale, overlapping or UNKNOWN claims cannot be
  approved. This is a documented human Finance attestation; format validation
  is not a DJP lookup, registration verification, or legal/tax advice.
- A protected per-owner head serializes approval with new versions, including
  REPEATABLE READ writers whose earlier snapshot cannot see a winning version.
  Immutable event rows, unique submission/decision constraints, the 0495 GiST
  window exclusion, and an additional approval overlap check provide the
  corresponding direct-SQL protections. Event actors, times, evidence and
  decisions cannot be updated or deleted. Empty projection state can be
  rebuilt; downgrade refuses to remove populated approval history.

## Resolution and historical boundaries

`resolveHandymanTaxIdentityAt` remains the 0495 unapproved-assertion reader.
`requireApprovedHandymanTaxIdentityAt` reads the profile, actual effective
window, submission and checker decision in one database snapshot, recomputes
and matches the V1 digest, rechecks exact scope, maker/checker separation,
evidence and window provenance, and returns `taxUse.allowed = true` only for
an intact matching approval. Missing, rejected, unknown, tampered or invalid
facts fail closed.

Authority begins at the **later** of the profile's effective-from and the
server-recorded checker decision; the server rounds event timestamps up to the
next millisecond. Approval cannot retroactively authorize an earlier instant.
The authorized end is bounded by the approved window, a later prospective
closure/cancellation, and any issuer-profile supersession. Microsecond issuer
supersession is conservatively truncated to the public millisecond boundary.
An already approved older version remains provable for its historical interval; a new
version has no authority until separately approved. Future window changes do not
mutate the prior digest or approval event. Downstream financial facts are not
backfilled, and 0494's tax-configured distinct-BM earning and distinct-BM
settlement guards are unchanged.
