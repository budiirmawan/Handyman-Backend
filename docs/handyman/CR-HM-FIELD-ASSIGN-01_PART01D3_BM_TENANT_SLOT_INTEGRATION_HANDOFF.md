# CR-HM-FIELD-ASSIGN-01 PART 01D-3 — BM tenant slot-choice integration handoff

Audience: BM Super App developer. Scope: the **existing** Handyman endpoints only. This document adds no endpoint and no engine. Depth on the data model is in `CR-HM-FIELD-ASSIGN-01_PART01D2_TENANT_SLOT_CONSENT.md`; this file is the integration checklist.

**Status: NOT CERTIFIED. Customer booking and confirmation stay DISABLED.**

- `bookingEnabled` and `confirmationEnabled` are `false` in default Production.
- No integration row, grant or secret is provisioned by any migration or by this change.
- The test in `tests/handyman-tenant-slot-bm-http-integration.test.ts` uses a **simulated** BM issuer. It proves Handyman's verification against the contract. It does not prove that BM is integrated or certified.

Baseline: `main` at `e6ed605` (PR #22 merged). Migration `0434_create_handyman_tenant_slot_consents` is present. Branch: `arena/ee3e97f6-handyman-backend`.

## 1. Authority model

| Actor | Authority |
|---|---|
| Tenant (BM Super App, authenticated) | Chooses the requested date and time. The choice is a **requested slot**, never CONFIRMED. |
| BM | Authenticates the tenant, maps the tenant to a Handyman tenant PIC, issues the evidence ID, and signs the assertion. |
| Handyman Operations | Matches an eligible registered Inspector or Crew to the tenant's exact slot. Cannot move the slot. |
| Handyman backend | Sole booking authority. Verifies the assertion, records consent, binds the visit, and confirms with a capacity reservation. |

## 2. Endpoints (existing, no additions)

| # | Method and path | Caller | Permission | Effect |
|---|---|---|---|---|
| 1 | `POST /api/v1/handyman/integrations/tenant-slot-choices` | BM server (no session) | HMAC signature only | Records request-level consent. Binds to a PROPOSED visit only on exact slot match. Never CONFIRMED. |
| 2 | `GET /api/v1/handyman/requests/:requestId/visits` | Operations session | `tenant_company.read` | Lists visits. Returns `bookingEnabled` and `confirmationEnabled`. |
| 3 | `POST /api/v1/handyman/requests/:requestId/visits` | Operations session | `tenant_company.manage` | Proposes a resource at a slot. Must match a pending tenant choice exactly. |
| 4 | `POST /api/v1/handyman/requests/:requestId/visits/:appointmentId/confirm` | Operations session | `tenant_company.manage` | `TENANT_SELECTED` → `CONFIRMED` with an atomic reservation. Fail-closed while authority is off. |
| 5 | `POST .../visits/:appointmentId/cancel-proposal` | Operations session | `tenant_company.manage` | Cancels a PROPOSED visit only. |

## 3. Minimum contract BM must provide

| # | Requirement | What Handyman verifies | Status |
|---|---|---|---|
| 1 | **Authenticated tenant identity** | BM asserts the tenant session. Handyman has no tenant session principal. | OPEN. BM must define and certify the tenant authentication step. |
| 2 | **Mapping to the correct tenant PIC** | `tenantPicId` must equal the request's stored PIC. The PIC must belong to the company and building. A mismatch returns 401. | Verified in code and tests. BM must define the user-to-`tenant_pics.id` mapping. |
| 3 | **Tenant date and time choice** | Exact `selectedStartAt` and `selectedEndAt`, with offsets. End must be after start. The slot must be in the future. | Verified in code and tests. |
| 4 | **BM consent evidence ID** | `bmConsentEvidenceId` is unique per integration and stored as provenance. Reuse returns 409. | Verified in code and tests. |
| 5 | **Signing key custody and rotation** | Per integration secret `HANDYMAN_VISIT_SLOT_SECRET_<CODE>`, separate from the handoff secret. HMAC-SHA256 over `stableJson(body)`. | OPEN. See section 5. |
| 6 | **Re-choice when the slot is unavailable** | None. A second pending choice for the same request and kind returns 409. Nothing withdraws or supersedes a pending choice. | **MISSING. Blocker.** See section 6. |

## 4. Assertion contract

Header: `x-handyman-tenant-slot-signature: sha256=<hex>`.

Body: closed set, all fields required, no extra members.

```json
{
  "iss": "BM_TENANT",
  "aud": "handyman-backend",
  "purpose": "TENANT_SLOT_CHOICE",
  "jti": "<16–128 chars, unique per integration>",
  "iat": "2031-11-13T03:00:00.000Z",
  "exp": "2031-11-13T03:02:00.000Z",
  "handymanRequestId": "<lowercase canonical UUID>",
  "kind": "INSPECTION",
  "tenantCompanyId": "<lowercase canonical UUID>",
  "buildingId": "<lowercase canonical UUID>",
  "tenantPicId": "<lowercase canonical UUID>",
  "tenantUserReference": "<opaque BM user ref, 1–128>",
  "selectedStartAt": "2031-11-14T10:00:00+07:00",
  "selectedEndAt": "2031-11-14T11:00:00+07:00",
  "bmConsentEvidenceId": "<BM-issued, unique per integration>",
  "method": "BM_AUTHENTICATED_TENANT_SELECTION"
}
```

Rules:

- `exp - iat` ≤ 300 s. `iat` ≤ now + 60 s. `exp` > now.
- UUIDs must be lowercase. The signature covers the exact wire form.
- The signature is `sha256=` + HMAC-SHA256 over `stableJson(body)`, compared in constant time.
- Every structural, trust, signature, freshness, scope or identity failure returns one 401 `HANDYMAN_VISIT_SLOT_ASSERTION_INVALID`. Nothing is enumerated.
- A replayed `jti` or `bmConsentEvidenceId` returns 409 `HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED`.
- A second pending choice for the same request and kind returns 409 `HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT`.
- Success returns `confirmedBooking: false`. There is no token, session or capacity claim.

## 5. Open decisions for the business owner

1. **Signature scheme.** HMAC means Handyman also holds the verifying secret, so BM cannot prove non-repudiation. For production, consider asymmetric signatures where Handyman holds only the public key. This is a new contract and is not implemented.
2. **Rotation.** Each integration has a single secret and no key ID or overlap window. Rotation today means a coordinated cut-over. Define the rotation procedure before provisioning.
3. **Availability source.** Which system publishes the slots the tenant can choose from? Handyman has no availability contract.
4. **Decline path.** Who may withdraw a pending choice, and does a visit that is `TENANT_SELECTED` have a cancel path? Cancel currently covers PROPOSED only.

## 6. Re-choice blocker

When Operations cannot match an eligible resource to the tenant's slot, the consent stays pending. Current behaviour:

- A second tenant choice for the same request and kind returns 409. The test asserts this, so there is no silent replacement.
- No endpoint lets the tenant withdraw or supersede a pending choice.
- Operations cannot change the tenant's slot.

Blocker: the business rule "if unavailable, the tenant selects an alternative" has no code path. The fix needs a decision on withdraw or supersede semantics. It must not be implemented as an Operations substitution.

## 7. RBAC review (Operations Confirm)

- The confirm route uses `tenant_company.manage`. Proposal and cancel use the same permission, and so do 27 other `requirePermission` call sites across Handyman write routes.
- No existing permission code is narrower and fits "Handyman visit confirm". Tightening therefore needs a new permission code, a seed change and a migration. That is an RBAC change, so it is **not** made here.
- Confirmation is already gated by config. While the BM grant or secret is absent, confirm returns 409 `HANDYMAN_VISIT_CONFIRMATION_DISABLED` before any lock or write.
- Recommendation: a dedicated confirm permission in a separate CR, granted to the Operations role only. Until then, `tenant_company.manage` is the boundary.

## 8. Default Production configuration

- `handyman_handoff_integrations.tenant_slot_choice_scope` defaults to FALSE. No migration sets it TRUE.
- No `HANDYMAN_VISIT_SLOT_SECRET_<CODE>` is deployed in Production.
- Result: ingest returns 401, `bookingEnabled` and `confirmationEnabled` are `false`, and confirm returns 409.
- Enabling this path requires BM certification, an explicit integration row with the grant, and a deployed secret. None of these are done in this change.

## 9. Verification

```
npm run typecheck
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/handyman-tenant-slot-bm-http-integration.test.ts
```

The focused test runs over HTTP against a disposable, fully migrated embedded PostgreSQL. It covers:

- default Production: ingest, readiness and confirm all closed;
- invalid signature, tampered payload, unknown issuer and missing signature, each a single 401 with no write;
- identity: wrong PIC is 401; a building without tenant context is 400;
- replay by `jti` and by evidence ID;
- single pending choice, and exact-slot matching;
- Inspector and Crew eligibility: unassigned, unplaced and unauthorised scope are refused, and the choice stays pending;
- authorised happy path: `TENANT_SELECTED` → `CONFIRMED`, one reservation, one audit, idempotent replay;
- capacity conflict: 409, rolled back to `TENANT_SELECTED` with no reservation or audit;
- RBAC: read-only is 403 on propose; anonymous is 401.

Session and permission lookups are the only seams. Everything else runs against the real database.
