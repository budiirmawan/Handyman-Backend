# BM staff SSO and Building scope — BLOCKED / transport only

Baseline: `8e078d0b75c1d113cfebd84d283a186bb8243395`.

## Release status

**Do not enable the BM staff WebView login journey. No staff SSO session can be
created by this change.** An authenticated transport receipt is not admission,
not a User identity, not a Building grant, and not a Care/PIC credential.

Scoped production-contract inspection found:

- `handyman_handoff_integrations` authenticates an ACTIVE BM integration with its
  existing per-integration environment HMAC secret and CUSTOMER_CARE capability.
- `handyman_handoff_care_actors` identifies an ACTIVE, integration-scoped opaque
  Care actor. `handyman-care-actor.types.ts` and its service explicitly make this
  a **non-User, non-PIC principal**. Actor references must not be interpreted as
  local User IDs or email addresses.
- `handyman_care_property_grants` authorizes the existing non-User Care channel
  at property scope, not exact local staff Building assignments.
- ACTIVE Users, active RBAC permission chains and exact active
  `user_building_assignments` exist independently.
- No approved production BM staff subject-to-existing-User binding, or explicit
  local staff CUSTOMER_CARE entitlement, was found in these scoped contracts or
  the foundation access seeds. Neither may be manufactured from signed claims.

Consequently User ACTIVE/CUSTOMER_CARE/exact-Building admission and ongoing
staff-session authorization, staff session expiry/logout/revocation, and a
successful staff login remain **blocked, not implemented or certified**.
Existing Care and signed Tenant PIC sessions retain their existing semantics;
this work does not reinterpret their property scope as staff Building authority.

## Independently safe transport

Base: `/api/v1/handyman/care/staff-sso`. All routes reject query parameters,
set `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and
`X-Handyman-Staff-SSO: blocked-staff-authority`. Login-failure throttling reuses
the existing process-local limiter in separate socket-address namespaces.

### POST /launches (BM server to Handyman server only)

Header: `x-hub-signature-256: sha256=<lowercase HMAC-SHA256 hex>`.
The signed body must have exactly these fields:

```json
{
  "purpose": "HANDYMAN_BM_STAFF_LAUNCH",
  "integrationCode": "REGISTERED_BM_CODE",
  "issuer": "REGISTERED_BM_CODE",
  "audience": "HANDYMAN_BM_STAFF_SSO",
  "assertionId": "<unique UUID>",
  "staffReference": "<existing integration-scoped Care actor reference>",
  "buildingId": "<requested Building UUID>",
  "issuedAt": "<UTC timestamp with milliseconds>",
  "expiresAt": "<UTC timestamp with milliseconds>"
}
```

Canonicalization is the existing `stableJson`: recursively sorted object keys,
compact JSON, normal JSON string escaping, array order retained. HMAC covers
all fields, including fixed purpose/audience and issuer equal to the registered
integration code. Codes are restricted to uppercase letters, digits and
underscores to avoid aliases in the existing normalized environment key lookup.
Use `HANDYMAN_HANDOFF_SECRET_<CODE>` with at least 32 bytes of secret material.
No new credential registry/keyring, key IDs, user provisioning or grants exist.

Clock requirements: `issuedAt <= now < expiresAt`, positive lifetime at most
60 seconds, UTC ISO timestamps exactly to milliseconds. There is no future
clock-skew allowance. BM and Handyman clocks must be synchronized.

The current integration, Care actor, property grant and active physical
Client/Property/Building hierarchy are locked and checked. This is only a
**transport eligibility check**, not local staff exact-Building authorization.
A sibling Building under that property can satisfy transport eligibility; it
still cannot obtain a session or perform any operation with this receipt.

202 response uses the normal success envelope. `data` contains only
`launchReference` (random 256-bit `hbsl_` reference) and `expiresAt`. The expiry
is no later than the assertion expiry or 60 seconds after issuance. A 202 is
**NOT** a successful staff login. Store/deliver only this short-lived one-time
reference to a future frontend; never put integration secrets, assertions,
reusable credentials or workspace/session tokens into WebView URLs.
Currently there is no usable staff launch/login URL and no frontend enabled.

The database stores only a SHA-256 reference digest and keyed credential
binding, not the reference, secret, signature or full assertion. Unique
`(integration_id, assertion_id)` prevents durable assertion replay. Consumption
and revocation are irreversible; replay history cannot be deleted by ordinary
row operations. Audit contains receipt/actor/integration/Building IDs and
explicit `staffSessionCreated: false`, not credential material.

### POST /exchange

Body: `{ "launchReference": "hbsl_..." }`, no other fields.
Rechecks live transport authority, original property-grant identity, current
credential binding and expiry. Row locking/conditional mutation enforces one
consumer, including concurrent requests.

An otherwise valid reference is **consumed atomically with an audit event**,
then returns 409 `HANDYMAN_BM_STAFF_AUTHORITY_UNAVAILABLE`. No cookie, User
session, Care session or PIC session is issued. Subsequent use returns 401
`HANDYMAN_BM_STAFF_HANDOFF_UNAUTHORIZED`. Invalid, expired, revoked, replayed
or wrong-key references uniformly return that 401. An audit/database failure
rolls back consumption and does not grant a session.

### POST /revoke

Same single-field body. Reference holders can discard a pending transport
receipt. Returns 204 for well-formed references, including unknown or already
revoked references; never revokes a User/Care/PIC session. This is **pending
launch cancellation, not staff-session logout**.

## Revocation and rotation

Integration deactivation/capability withdrawal or Care actor deactivation
irreversibly revokes pending transport receipts through additive migration
0452 triggers. Live property grants and physical scope are also checked at
exchange. None of this establishes a local staff authorization bridge.

Safe existing-secret rotation procedure:

1. Authorized operators deactivate the integration using its existing authority.
   Commit the status change before distributing any new credential. The trigger
   permanently revokes pending receipts, preventing reactivation resurrection.
2. Replace the scoped environment secret on **all** Handyman replicas and on BM;
   drain/restart replicas as required by the existing deployment mechanism.
3. Confirm every replica has the new secret; then reactivate the integration.
4. Issue fresh UUID assertions. Never recycle assertion IDs or old secrets.

A changed current secret additionally rejects an outstanding receipt by keyed
binding. Direct hot-swapping/restoring a secret without deactivation is not the
supported rotation procedure. No dual-key grace period is implemented.
Existing legacy Care/PIC session lifecycle remains unchanged by this addition.

## Required production decisions before enabling SSO

- Approve and supply a server-managed, integration-scoped immutable staff subject
  binding to an **existing** Handyman User, with revocation/lifecycle semantics.
  Neither a supplied User ID/email nor an existing Care actor reference is proof.
- Define the existing/local RBAC entitlement that constitutes CUSTOMER_CARE,
  including who may administer/delegate it. Do not use integration capability or
  `handyman.payment.report` as a substitute for staff workspace permission.
- Define exact Building assignment authority and enforce it along with User
  status and live RBAC on admission **and every protected staff Care operation**.
- Implement bounded secure staff-session exchange/cookies, expiry, logout and
  immediate authority revocation only after those decisions, without accepting
  this transport reference on legacy Care or PIC endpoints.
- Configure production BM integration/actor/secret, trusted backend signing,
  protected POST delivery, TLS, synchronized clocks, all-replica rotation and
  credential-redacting gateway/APM/WebView behavior. Nothing here certifies BM UI
  or production identity provisioning.

No Gatepro, Platform Admin, SaaS provisioning, new privileged User/grants or
staff-to-PIC impersonation. Migrations 0441–0451 and the signed PIC decision
engine, explicit quotation-version/PIC binding, S1 staff403 and B12 OFF remain
unchanged.

## Validation — 2026-10-12 (Asia/Jakarta)

Validated source/test/API checkpoint:
`dcc63c621f80f21ef5768dc6af5aaa410734dd0d`.

| Check | Actual result |
| --- | --- |
| New isolated PostgreSQL/HTTP transport tests | **12 PASS / 0 FAIL / 0 SKIP** |
| Bounded final run: transport plus seven existing Care/PIC/quotation/inspection files | **63 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED**, 154.41 seconds |
| Production `npm run typecheck` | **PASS**, exit 0, 30.06 seconds |
| OpenAPI YAML parse, three registered paths, referenced local schemas, no exchange success response | **PASS** |
| `git diff --check` | **PASS** |
| Historical migrations 0441–0451 | **Unchanged**; only new 0452 plus registry entry |
| Successful BM staff SSO admission, local User ACTIVE/CUSTOMER_CARE/exact-Building access, per-operation staff scope and staff-session logout | **BLOCKED / NOT RUN** — no production identity/entitlement bridge; not counted as passing or silently skipped tests |
| Production BM/WebView integration, multi-replica deployment/rotation | **NOT RUN**; prerequisites above, no deploy performed |

The initial focused run was 11 PASS / 1 FAIL because the isolation test called
an unregistered PIC URL. The test now uses the registered PIC session endpoint
and sends a complete request-create body. Focused rerun: 12 PASS. No runtime
security guard was relaxed. Intentional audit-failure tests emit database/HTTP
500 logs and assert rollback; those scenarios passed in the final run.

New checks cover signature/purpose/issuer/audience binding, strict timestamps
and TTL, unknown subjects and forbidden User/permission claims, inactive actors,
wrong property/Building and inactive hierarchy, concurrent assertion/reference
replay, expiry, irrevocable cancellation, integration/actor/capability revocation,
missing/weak/rotated keys, audit rollback, throttling, property regrant isolation,
credential separation and absence of created Users/grants/sessions.
These are transport tests, **not** a claim that authorized staff SSO works.

Existing passing regressions exercise signed Care intake, resident communication
and assisted quotation, explicit PIC/version binding, signed PIC approval,
exact-Building isolation under existing authorities, S1 staff403, B12 OFF, and
exactly one authorized Execution Scope. Historical inspections/revisits remain
intact. No full suite, unrelated audit, PR, deployment or privileged provisioning.

Final bounded command:

```sh
ASENTRA_USE_EMBEDDED_POSTGRES=true NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 \
  tests/handyman-bm-staff-launch-transport.test.ts \
  tests/handyman-care-quotation-assistance.test.ts \
  tests/handyman-care-assisted-quotation-journey.test.ts \
  tests/handyman-care-workspace-request-detail.test.ts \
  tests/handyman-pic-workspace-session.test.ts \
  tests/handyman-direct-quotation-journey.test.ts \
  tests/handyman-inspection-integrated-journey.test.ts \
  tests/handyman-inspection-revisit-journey.test.ts
npm run typecheck
```

Pushed bounded checkpoints:

- `976674e017d872e2957b92ce09c68705e923af84` — transport and explicit blocker.
- `13abf9eccdb62e1f3773d609ad43b4e8f5750c79` — PostgreSQL/HTTP tests before execution.
- `dcc63c621f80f21ef5768dc6af5aaa410734dd0d` — API docs and focused-test correction,
  pushed before final bounded regressions.

This results record is a documentation-only follow-up to the validated checkpoint.
