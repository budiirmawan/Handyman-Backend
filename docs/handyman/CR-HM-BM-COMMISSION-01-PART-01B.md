# CR-HM-BM-COMMISSION-01 — Part 01B: BM identity and Building coverage

## Scope

Migration `0493` adds a Client-scoped BM legal identity, a separate immutable
verification decision (actor, evidence reference, server timestamp rounded up
to the next millisecond), and explicit effective-dated Building coverage. A registration is **not** a
verification. The internal `handyman-bm-binding` domain commands are trusted
server-side interfaces, not HTTP endpoints: their caller must authenticate and
authorize the existing Client/Building scope. No IAM permissions or routes are
introduced in this part.

A coverage row binds one verified legal identity to one Building and the exact
existing commercial agreement **version**, DEFAULT BM rule, and BM term. The
rule and term remain the existing version-bound contracts, not copies or a new
pricing engine. `[effectiveFrom, effectiveTo)` boundaries are explicit; the
start cannot predate recorded verification or the version's start, and the
window cannot outlive a closed version. The Client is checked through both
Building → Property → Client and version → agreement → Client. No coverage is
inferred for another Building or a replacement version. An exclusion constraint
rejects even concurrent overlapping windows for a Building.

## Beneficiary semantics and transition

* `CLIENT_ORGANIZATION` coverage explicitly refers to the existing immutable
  0415 beneficiary definition for the exact version. Its verified legal identity
  must explicitly represent that same Client; a name or channel attribution is
  not proof of equivalence.
* `BM_LEGAL_COUNTERPARTY` coverage names a distinct verified legal identity for
  that particular Building/version. Multiple Buildings under one Client may
  name different BMs. This is **not** a rewrite of the old Client beneficiary or
  a new Client, and it is not inferred from the old beneficiary. The resolver
  returns this identity alongside the existing rule and term anchors; it must not
  be replaced by the Client-level 0415 beneficiary.
* Existing 0415 definitions, earned entitlement facts, and settlement facts
  are not migrated, reinterpreted, or rewritten. Existing paired earned facts
  continue to replay/correct against their original anchors without requiring a
  retroactive coverage record. No automatically inferred backfill occurs.

For **new** BM entitlements, both the service and database require an exact
verified Client-beneficiary Building binding at the ledger posting time. The
legacy entitlement schema can reference only `clients`: a distinct BM legal
party therefore **fails closed** rather than being paid as the Client. Supporting
new distinct-BM entitlement/settlement facts needs a later, separately
contracted change; this part does not implement fee, tax, pricing or settlement
calculations. Verification must precede the coverage start: transactions posted
before verification are not made eligible by backdating.

## Lifecycle and operation

1. Register the legal name and registration number within the Client scope; if
   the entity is actually the Client, record that representation explicitly.
2. An authorized internal caller records the verification decision and its
   evidence reference. Identity and verification are immutable; correcting an
   identity requires a new registration and verification.
3. Once the commercial version is effective and has its DEFAULT rule and term,
   explicitly bind each covered Building and exact version. For a legacy Client
   beneficiary supply its existing definition id; for a distinct legal BM use
   the verified counterparty and no Client beneficiary definition id.
4. Resolve using Client, Building and an explicit timezone-bearing `asOf` instant.
   Missing, cross-Client, unverified or non-effective coverage fails closed.
5. Before a version is superseded, prospectively close its Building coverage at
   or before the replacement boundary. A future, not-yet-effective binding may
   instead be cancelled. Past coverage and verified identity are not editable;
   supersession never silently carries coverage to a new version.

Downgrading `0493` is refused if any identity, verification or coverage history
exists. The migration does not create a backfill and retains the shared
`btree_gist` extension on empty rollback.
