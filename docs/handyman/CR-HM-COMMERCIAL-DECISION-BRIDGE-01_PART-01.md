# Commercial decision bridge — PART 01

Date: 2026-10-25. Backend receiver implemented; **live customer-consent integration BLOCKED**.
This is an additive channel, not another approval engine or a production/E2E certification.

## Authority and frozen boundaries

Tenant → Customer Care → existing Handyman quotation / BAST transactions. Tenant remains the decision-maker;
Care is the actual recorder. No tenant login, new persona, account provisioning or customer portal is required.
Direct authenticated request-PIC decisions remain optional and retain PART02–05 protections and their original V1 receipt meaning.
Catalog PR60, pricing/inspection/preparation/revision, provider/QC, Finance, BM permits/fees and assignment authority are unchanged.
Handyman remains the external provider; tenant pays Handyman upfront/DP; BM is partner/permit authority and receives contractual percentage fees.
The Handyman Manager also performs Finance verification; consent does not bypass or replace it. Other close gates remain independent.

## Exact missing integration — do not enable from a Care statement

Existing signed handoff establishes **Care identity and represented context**, not commercial customer intent.
Existing tenant-slot assertions establish **scheduling consent only**. Communications stay `PENDING_VERIFICATION`;
request-owned attachments prove association/integrity, not who consented. None is promoted automatically.

A BM server independently verifying the real customer must produce an exact-target commercial assertion, and retain
an auditable, retrievable verification receipt. Its verification reference must identify the actual customer's
intent, subject identity, represented Company/PIC if present, exact artifact and decision, **independently of Care's report**.
A generic Care operator assertion, signed-in Care session, screenshot, contact name/phone or opaque evidence ID alone is insufficient.
No approved live commercial producer/verification contract has been supplied to this Backend PART. A signing key does not by itself prove a human consented.

**Default fail closed:** migration 0481 enrolls nobody. The integration's `commercial_consent_contract_ref` is NULL.
The new receiver returns 503 `HANDYMAN_COMMERCIAL_CONSENT_INTEGRATION_BLOCKED` until BOTH:
1. a reviewed independent customer-verification integration contract is explicitly enrolled out of band; and
2. its dedicated server-held `HANDYMAN_COMMERCIAL_CONSENT_SECRET_<NORMALIZED_INTEGRATION_CODE>` is installed (at least 32 characters).

No enrollment API, role grant or Care-controlled opt-in exists. Never set the contract reference merely to make a button work.
The consent key must differ from handoff/workspace and tenant-slot keys and must never reach Care clients/browsers.
No live enrollment, secret, deployment or actual customer verification is supplied by this PART.

## Transport (relative to `/api/v1`)

Use the **existing** `Authorization: Bearer <hcw_...>` workspace credential from BM-signed Care admission;
no local User token can substitute. Current session, active integration/actor, exact physical hierarchy, property grant,
Company, tenant-Building/space occupancy and optional active stored PIC are rechecked and locked inside the decision transaction.
A Care property grant permits recording within that scope; it does not grant customer approval authority.

1. `POST /handyman/care/requests/{requestId}/communications`: existing communication fields and request-owned evidence IDs.
   Actual recorder is the workspace Care actor; `recorded_by_user_id` remains NULL. Returns the neutral communication ID.
2. `GET /handyman/care/requests/{requestId}/commercial-targets/{targetType}/{targetId}`:
   `targetType` is `QUOTATION_VERSION` or `BAST`. Returns server-derived `{target:{type,id,digest}, customer:{...}}`;
   quote must be ISSUED/unexpired, BAST ISSUED. This digest/read is **not consent**. Present the actual existing
   quotation/issued BAST to the customer; do not ask the customer to approve an opaque hash alone.
3. After independent customer verification, relay:
   - `POST /handyman/care/requests/{requestId}/quotation-versions/{targetId}/decision`
   - `POST /handyman/care/requests/{requestId}/bast/{targetId}/decision`
   Body: `{decision:"ACCEPT"|"REJECT", idempotencyKey, consentAssertion}`; BAST alone also accepts `rejectReason`.
   Quote ACCEPT maps to the existing engine's APPROVE, without a second lifecycle. No caller recorder/PIC/User fields are accepted.
   Header: `x-handyman-commercial-consent-signature: sha256=<lowercase HMAC-SHA256>`.

## Purpose-specific assertion and verification

Closed field set (all required; canonical lowercase UUIDs, canonical UTC ISO timestamps):
`iss, aud, purpose, method, jti, iat, exp, careActorId, clientId, handymanRequestId, tenantCompanyId,
tenantPicId, buildingId, spaceId, communicationId, customerReference, verificationReference,
targetType, targetId, targetDigest, decision, rejectReason`.

- `iss`: existing active BM integration code; `aud`: `handyman-backend`.
- `purpose`: `HANDYMAN_CUSTOMER_COMMERCIAL_DECISION_V1`; `method`: `BM_VERIFIED_CUSTOMER_CHANNEL_V1`.
- HMAC input: UTF-8 `purpose + "\u0000" + stableJson(assertion)` using existing sorted-key canonical JSON convention.
  No handoff, create-exchange, workspace or slot token/signature is accepted as this proof.
- `jti`: 16–128 characters, unique per integration; `exp > now`, `iat <= now`, lifetime ≤300 seconds.
- `customerReference` / `verificationReference`: 1–200-character references to the independently verified customer and retained proof.
  They are provenance, not local account identifiers or authorization invented by this Backend.
- Context must equal the stored request in every field. `tenantPicId` and `spaceId` are explicitly nullable;
  null is preserved, not replaced by Care or an invented customer. No linked User is required for this channel.
- `communicationId`: same request/Client/Building, actual Care recorder and corresponding purpose/reported decision.
- `targetId` / `targetDigest`: exactly the server target above. Quotation identity binds its immutable ISSUED version.
  BAST digest binds the ISSUED v2 artifact, issue event/time, QC run, approved quote, scope and customer/location roots;
  accepted/rejected v3 projections never retarget historical consent.
- `rejectReason`: literal null for quotation and ACCEPT; BAST REJECT must match its normalized command reason.

## Persistence, replay and downstream use

One transaction owns the immutable consent receipt, existing decision/event/sign-off, lifecycle projection,
approved execution scope and audit. Failures roll back together; an independently recorded communication remains neutral.
A receipt snapshots issuer/contract, external subject and proof reference, exact assertion hash, actual Care actor and server time.
Quotation `decidedByUserId`, scope `createdByUserId` and BAST `actorUserId` are NULL in Care mode;
additive Care-actor FKs record the real actor, never a borrowed customer User. Exactly one recorder is enforced.
Used communications/evidence links and receipts cannot be rewritten. No legacy rows are back-certified.

Same-key replay requires original exact proof, actor and payload, plus current workspace/scope/issuer authority.
A stored exact receipt can replay after its original assertion expires; it cannot mint another decision or transfer to another actor.
Signature verification still requires the current enrolled key. Key rotation/revocation may therefore block old command retries;
use the existing authorized read surfaces for historical records instead of minting replacement consent.
Different proof/key/decision/version/actor conflicts; concurrent first decisions serialize on the original aggregate locks.
First writes recheck proof, workspace and current effective occupancy/property authority after QC/evidence waits. QC PASS and exact issued artifact remain mandatory for ACCEPT.

The shared BAST qualifier recognizes either unchanged personal-PIC V1 or the new immutable verified Care receipt
(`HM-BAST-VERIFIED-CARE-CONSENT-SHA256-V1`), including actual Care actor + receipt FK + canonical digest.
Existing acceptance reads, warranty, final-charge and final-close consumers reuse that predicate.
Care does not gain warranty/rework/variation, Manager, Finance, permit or assignment authority.

## Next integration handoff / stop

BM must implement and demonstrate independent customer verification and retained proof for both decisions,
relay the target-bound signed assertion server-to-server, and complete a scoped cross-repository negative/positive integration check
before any real issuer enrollment. If that independent verification cannot be established, keep the bridge BLOCKED.
Tests with a TEST-only enrolled issuer validate the receiver; they do not certify BM human verification or production readiness.

## Focused receiver validation (2026-10-25)

- **103 tests / 7 suites PASS**, zero failures/cancellations/skips; 235.7 seconds.
  Includes 22 new bridge/assertion cases and relevant existing quotation, personal-PIC BAST,
  Care communications and workspace request-detail regressions. No full suite run.
- `npm run typecheck` PASS (source TypeScript).
- OpenAPI YAML/unique operation IDs/all 20,983 local references PASS:
  2,069 operations / 2,338 schemas, including four new workspace operations.
- Migration 0481 up/down/reapply tested in dependency order on disposable embedded PostgreSQL;
  downgrade refuses to erase existing Care consent/communication provenance.
- Test-only independent issuer enrollment, managed-byte QC/BAST evidence, exact proof replay,
  cross-actor/context denial, revocation/expiry lock waits, natural occupancy expiry,
  concurrent opposing decisions and injected transaction rollback are covered.
- No live issuer enrollment, BM human verification, production mutation or deployment was performed.
  Passing receiver tests do **not** close the live integration blocker above.

Reproduce the focused test run:

```sh
NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true \
node --import tsx --test --test-concurrency=1 \
  tests/handyman-commercial-consent-assertion.test.ts \
  tests/handyman-commercial-decision-bridge-part01.test.ts \
  tests/handyman-quotation-decision.test.ts \
  tests/handyman-bast-customer-authority-part04.test.ts \
  tests/handyman-care-communications-http.test.ts \
  tests/handyman-care-workspace-request-detail.test.ts
```
