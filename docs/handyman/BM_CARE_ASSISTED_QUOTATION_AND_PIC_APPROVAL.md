# BM Customer Care assisted quotation and PIC approval

Owner authority implemented on **2026-10-12**, starting at
`c21cda2534fecdc097c618f851216f1f9574d414`, branch
`arena/d04dc185-handyman-backend`.

## Authority boundaries

- BM Customer Care handles resident communication through BM Super App.
- Handyman Operations prepares, prices and issues quotations using existing
  quotation permissions, inspection/direct-policy prerequisites and lifecycle.
- Issuing a quotation makes it available in the scoped **BM Care workspace**.
  This is **not** a claim that the resident received it.
- Customer Care records presentation and facilitates a version-bound handoff.
  A Care actor is not a local staff User and is never fabricated as a Tenant PIC.
- Only an independently authenticated **Tenant PIC** can approve/reject. The
  existing signed PIC assertion, session, explicit quotation binding,
  maker/checker safeguards, decision ledger and Execution Scope engine remain
  authoritative. Care cannot prepare quotation lines, grant a binding or approve.
- **No automatic resident messaging or resident approval-link delivery exists.**
  No notification, email, WhatsApp, push or secure-link provider is called by this
  feature. Existing operational audit/outbox infrastructure is reused, not a new
  resident communications engine.

## Intake channels

`POST /api/v1/handyman/requests/care` accepts optional `residentIntakeChannel`:

`WALK_IN | WHATSAPP | EMAIL | PHONE | OTHER`

The value is validated at both HTTP and service layers and recorded with the
Care actor and server time, atomically with the existing single-use Care exchange,
request, attribution and contacts. It does **not** replace `BM_SUPER_APP` origin,
create resident identity or grant approval permission. Unknown values fail 400.

Optionality preserves existing BM clients. Omitted/historical values remain
unrecorded (null in the quotation inbox), not invented as OTHER. New BM clients
should always send the observed channel. Presentation may use a different channel
from intake; both facts are preserved independently.

## API contract

All responses use the existing success/error envelopes and `Cache-Control:
no-store`. The OpenAPI document contains complete inputs/projections.

### Care workspace credential (`hcw_`)

Every endpoint requires explicit query selection `propertyId`, `tenantCompanyId`,
`buildingId`, with optional narrowing `spaceId`. It reuses the existing active
Care integration/actor/session, property grants, Client/Property/Building/Tenant
and effective tenant/space occupancy with the active physical hierarchy. IDs are
references, never authorization. Local staff, PIC and exchange tokens are not
accepted as Care sessions. Unknown context/body fields are rejected.

| Method/path below `/api/v1/handyman/care` | Purpose |
|---|---|
| `GET /quotation-inbox` | Current, unexpired ISSUED quotations only; scoped before pagination |
| `GET /requests/:requestId/quotations/:versionId` | Customer-presentable commercial snapshot plus presentation/handoff history |
| `POST /requests/:requestId/quotations/:versionId/presentations` | `{channel}` and UUID `Idempotency-Key`; records presentation, returns 201 |
| `POST /requests/:requestId/quotations/:versionId/pic-handoffs` | `{presentationId}`; pins exact version and active explicit binding, returns 201 |

Inbox pagination uses `afterVersionId` (exclusive UUID boundary, ascending) and
`limit` (1–100, default 25). It is a current read, not a historical snapshot; all
rows are reauthorized before pagination. No counts from inaccessible contexts
are exposed. DRAFT versions never appear, including through direct detail reads.
Non-DRAFT history remains readable only while current Care scope is authorized.

Issue-time delivery records the issuing local User, server timestamp and exact
version in an append-only delivery fact, with an atomic operational event.
`deliveryChannel=BM_CARE_WORKSPACE` means workspace availability, not resident
transport. Existing issued quotations remain readable; their delivery actor/time
are null if no new delivery fact exists. No history or issuer is fabricated.

Presentation is a **Care attestation**, not independent proof the resident read
or consented. Presentation actor, session, channel, timestamp and version are
persisted. A UUID key is unique per Care actor; identical or changed replay is
409 rather than another presentation. A new intentional presentation may use a
new key. After a lost response, read the version's history before retrying.

A handoff requires a presentation of the same currently-issued unexpired version
and the effective Operations-managed explicit PIC binding. The server derives
all context and binding; the body admits no target PIC or actor. There is at
most one handoff per presentation. It expires at the earlier of quotation
validity or **10 minutes** after creation (database ceiling 15 minutes).

The response contains `id`, `quotationVersionId`, `approvalBindingId`, actor,
channel, server time/expiry, `authenticationRequired=SIGNED_TENANT_PIC_SESSION`,
and relative `picAdmissionPath` / `picClaimPath`. These paths are **API locations,
not login/approval credentials**. No resident address, generated PIC token,
signature, OTP, external callback URL or automatic outbound link is returned.
BM decides how to carry the reference in its own authenticated user interface.

### Independently authenticated PIC credential (`hpw_`)

1. Care passes the handoff reference to the **BM-controlled authentication UX**.
2. BM independently authenticates the actual Tenant PIC and submits the existing
   signed `HANDYMAN_PIC_WORKSPACE` assertion to `POST /api/v1/handyman/pic/session`.
   The assertion's strict payload, signature, capability, expiry and anti-replay
   rules are unchanged. A Care signature/capability or staff credential is not
   sufficient. No tenant/PIC identity is inferred from resident contact data.
3. With the resulting PIC bearer, call
   `POST /api/v1/handyman/pic/quotation-handoffs/:handoffId/claim` with empty body
   and no query context. This requires `canDecide=true`, the actual bound PIC,
   correct tenant/Building/Space, current version/binding and live handoff.
4. Claim records the independently authenticated PIC session/time and returns
   the exact version and relative `decisionPath`. It creates **no decision or
   Execution Scope**. The claim is single-use; duplicate or concurrent replay
   returns 409. Another session of even the same PIC cannot reuse the claim.
5. Call `POST /api/v1/handyman/pic/quotation-handoffs/:handoffId/decision` with
   `{decision: APPROVE | REJECT}` and existing 1–200 character `Idempotency-Key`.
   The handoff resolves the version server-side. The exact claimed PIC session,
   version and binding are revalidated inside the existing decision transaction.
6. The **existing PIC engine** writes the decision/audit and, for APPROVE, creates
   one authorized Execution Scope attributed to that PIC/session, never to Care.

Existing direct PIC decision routes remain available to independently authorized
PIC sessions; this additive route is not a new mandatory approval authority.
It specifically certifies the Care-assisted journey without weakening existing
PIC safeguards. A handoff's expiry bounds the assisted route, not a separate
independently authenticated PIC's general rights under the existing portal.

Replay distinctions are intentional: signed assertions and handoff claims are
single-use and rejected on replay; the existing **same-key, same-decision PIC
retry returns the original result**, never a second approval/scope. Changed-body,
wrong-version, wrong-session or unauthorized retries fail. After a decision,
a valid replay need not pass a new quotation/handoff time window to retrieve its
own original receipt. Current PIC session authentication still applies.

## Status and audit

Inbox presentation status is `AVAILABLE_TO_CARE` or `PRESENTED`. A handoff starts
`PENDING_PIC_AUTHENTICATION`, becomes `PIC_AUTHENTICATED` from the immutable claim,
and displays actual `APPROVE` or `REJECT` only when the existing ledger matches
its version, claimed session and binding. Otherwise expired, superseded or
revoked-binding handoffs read `STALE`. Quotation status is always independently
reported. No staff-entered status is accepted.

Operational events, in the same transactions as their facts:

- `HANDYMAN_CARE_RESIDENT_CHANNEL_RECORDED`
- `HANDYMAN_QUOTATION_DELIVERED_TO_CARE`
- `HANDYMAN_CARE_QUOTATION_PRESENTED`
- `HANDYMAN_CARE_PIC_HANDOFF_CREATED`
- `HANDYMAN_CARE_HANDOFF_PIC_AUTHENTICATED`
- `HANDYMAN_CARE_HANDOFF_PIC_DECIDED`

Care and PIC events have null `actor_user_id`; their genuine actor/session IDs
are explicit metadata, not impersonated local Users. Existing quotation approval
audit and decision/scope provenance remain unchanged. Secrets, credentials and
resident contact payloads are not copied into assistance audit.

## Database, authorization and concurrency

Only additive migration **0451** and migration registration are introduced.
Migrations through 0450 are untouched. The migration creates append-only intake
channel, delivery, presentation, handoff and PIC claim facts. It is forward-only;
rollback must not erase authoritative communications/authentication history.

- Foreign keys preserve version, presentation, binding and session identity.
- Database insert guards reject non-current/expired quotation facts, mismatched
  presentation/version, ineligible Care scope/session, mismatched/expired binding,
  and non-PIC/mismatched claim provenance. UPDATE/DELETE of history is refused.
- Care writes hold the existing integration/actor/session authority through the
  transaction, then recheck expiry after work. Grant/tenant occupancy and physical
  hierarchy locks keep concurrent revocation/turnover from silently authorizing
  an earlier selection. Existing occupancy SQL remains the authority, not a new
  tenant/customer registry.
- Quotation locks serialize presentation/claim with supersession and decisions.
  Binding locks preserve explicit binding identity during first decision.
- Unique keys plus the shared decision engine constrain concurrent presentation,
  handoff, claim and approval retries to one authoritative fact.
- Audit failures roll back issue/delivery or presentation rather than leaving
  unaudited partial success. No execution scheduling, pricing, inspection,
  cancellation, scope-authority or SaaS provisioning redesign was introduced.

Malformed input is 400, wrong credential kind/session is 401, inaccessible
resources use the existing uniform Care/PIC 404, and stale/duplicate assistance
uses 409 `HANDYMAN_CARE_QUOTATION_CONFLICT`. The underlying PIC decision engine
retains its existing decision conflict vocabulary. S1 staff approval stays 403;
B12 stays OFF (issue is not approval; a binding is still required to decide).

## Checkpoints and validation

- `f140813`: production contract/schema/services/routes; production typecheck PASS.
- `ba96bda`: initial focused tests and integrated HTTP journey, pushed before E2E.
- Focused PostgreSQL assistance file: **9 PASS / 0 FAIL / 0 SKIP**, 24.15 seconds.
- Integrated signed Care → inbox → presentation → signed PIC claim/approval →
  Execution Scope journey: **1 PASS / 0 FAIL / 0 SKIP**, 15.22 seconds.
- `af7af41`: authority locking, expanded nine-case PostgreSQL coverage and API/
  BM integration documentation; pushed before the final longer regression run.

### Final bounded validation at `af7af41`

```sh
ASENTRA_USE_EMBEDDED_POSTGRES=true NODE_ENV=test LOG_LEVEL=error \
  npx tsx --test --test-concurrency=1 \
  tests/handyman-care-quotation-assistance.test.ts \
  tests/handyman-care-assisted-quotation-journey.test.ts \
  tests/handyman-care-workspace-request-detail.test.ts \
  tests/handyman-pic-workspace-session.test.ts \
  tests/handyman-direct-quotation-journey.test.ts \
  tests/handyman-inspection-integrated-journey.test.ts \
  tests/handyman-inspection-revisit-journey.test.ts
```

**51 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED**, exit 0, **136.17 seconds**.
This includes nine new PostgreSQL assistance cases, the new integrated Care/PIC
journey, existing Care represented-scope and signed PIC admission/security cases,
and all three prior direct/inspection/revisit quotation-to-scope journeys.

`npm run typecheck`: **PASS**, exit 0, **30.43 seconds**, on the same runtime.
OpenAPI YAML, all six new paths and referenced components: **PASS**.
`git diff --check`: **PASS**. Migration comparison against the saved baseline
shows only new 0451 and registration; migrations through 0450 remain unchanged.
The final checkpoint records these results without changing runtime or tests.

At initial verification, restored workspace files matched `c21cda2` byte-for-byte
while the local Git pointer was at an older ancestor. After fetching the current
remote, the same branch was fast-forwarded to the exact expected baseline without
replacing files, resetting, stashing or losing changes. The worktree was clean
before implementation.

Initial test failures were infrastructure/fixture issues: embedded PostgreSQL's
package install symlinks needed hydration after `npm ci --ignore-scripts`; the
wrong-Building PIC fixture required a real tenant-space relationship; and binding
revocation correctly returns 200, not the test's initial 201 expectation. These
were corrected without bypassing runtime guards. Injected audit-error tests
intentionally observe 500 followed by full rollback and successful controlled
retry; they are not unresolved runtime failures.

## Remaining production integration limits

- BM Super App must implement the Care inbox/presentation UI, controlled handoff
  routing, independent real PIC authentication and server-side assertion signing.
  Handyman does not prove how BM authenticated the person behind a valid assertion.
- Production channel integrations/capabilities, secrets, Care actor property
  grants and Tenant PIC master/binding data must already be provisioned through
  their existing authorized procedures. Tests use isolated integrations and
  ephemeral secrets; live tenant provisioning is not certified here.
- Channel fields are business facts, not messaging-provider adapters or verified
  delivery/read receipts. Customer Care retains responsibility for resident
  communication. No automatic direct contact is configured or implemented.
- Old clients may omit the newly supported intake channel; historical facts are
  not guessed or backfilled. Existing issued-version inbox entries may lack the
  new delivery metadata, as documented above.
- No full suite, PR, deployment, Platform Admin change, unrelated redesign or
  destructive Git operation. Existing G9/live provisioning certification gaps
  are not claimed resolved by this bounded feature.
