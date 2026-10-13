# CR-HM-FIELD-ASSIGN-01 PART 01D-2 — Tenant slot-choice consent authority (contract + bounded implementation)

Baseline: PART 01D `2bf37fa` (pushed). Branch: `arena/bdfa247a-handyman-backend`. Repository guard: `budiirmawan/Handyman-Backend`.

**Status: customer booking confirmation remains DISABLED.** The BM-attested tenant slot-consent authority is not provisioned, so `bookingEnabled` and `confirmationEnabled` stay `false` in every environment until BM certifies the channel and Handyman provisions the integration.

## 1. Authority decisions

| Question | Decision |
|---|---|
| Who chooses the visit date/time? | The tenant, in BM Super App. Handyman never chooses it on the tenant's behalf. |
| Who proves the tenant clicked? | BM. Handyman verifies a BM-signed assertion and records BM's evidence ID. It does not infer or invent consent. |
| Is quotation approval booking consent? | **No.** `handyman-quotation-decision.service.ts` records the operator session as `decidedByUserId`, covers a quotation version and not a slot, so it is never reused. |
| Is a string `tenant_choice_evidence_ref` consent? | **No.** Consent exists only as an append-only row written from a verified assertion. |
| Is the tenant identity resolvable today? | Partly. The PART 02 resolver proves tenant company, active building relationship and ACTIVE tenant PIC from trusted claims. There is no tenant session principal. Identity for booking therefore remains **AUTHORITY BLOCKED** until BM defines the mapping (§5). |
| Who may trigger confirmation? | Operations only. The Ops confirm is a separate transaction from tenant choice. A `TENANT_SELECTED` visit is not `CONFIRMED`. |
| Is crew ACTIVE the same as booking confirmed? | No. Confirmation requires consent plus live eligibility plus an atomic capacity reservation. |

## 2. Classification (verified against live source)

| Contract | Class | Evidence |
|---|---|---|
| BM handoff trust channel (HMAC, per-integration secret) | EXISTING | `handoff-runtime.*`, `0375` |
| Slot-choice trust channel (separate purpose, separate secret) | **IMPLEMENTED here, inactive** | `handyman-tenant-slot-assertion.ts`, `handyman-tenant-slot-consent.service.ts` |
| Tenant identity for booking | AUTHORITY BLOCKED | Resolver exists (PART 02); no tenant session; BM mapping undefined |
| Consent provenance (append-only, one-time use) | **IMPLEMENTED here, inactive** | `0434`, `handyman_visit_tenant_slot_consents` |
| Appointment state, version, slot immutability | EXISTING | `0431` triggers |
| Capacity reservation schema (`btree_gist` exclusion, deferred commit guard) | EXISTING | `0431` |
| Capacity reservation transaction | **IMPLEMENTED here, inactive** | `handyman-visit-confirmation.service.ts` (`23P01` → 409) |
| Eligible resource matching (Inspector / Crew) | EXISTING | `assertVisitResourceAdmission` (shared by proposal and confirm) |
| Fail-closed authority gate | **IMPLEMENTED here** | `handyman-tenant-slot-authority.ts` |
| Decline / tenant rejection path | MISSING | Not designed (open decision §6) |
| CONFIRMED cancellation and reservation release | MISSING | No authority (open decision §6) |

## 3. Assertion contract (BM → Handyman, server-to-server)

Endpoint: `POST /api/v1/handyman/integrations/tenant-slot-choices`. No user session. Header: `x-handyman-tenant-slot-signature: sha256=<hex>`.

Body (closed set, all required, no extra members):

| Field | Rule |
|---|---|
| `iss` | BM integration code (1–64). Selects the integration row and its secret. |
| `aud` | Literal `handyman-backend` |
| `purpose` | Literal `TENANT_SLOT_CHOICE` |
| `jti` | 16–128 chars, unique per integration (one-time use) |
| `iat`, `exp` | RFC 3339 with explicit offset. `exp - iat` ≤ 300 s. `iat` ≤ now + 60 s. `exp` > now. |
| `handymanRequestId`, `appointmentId`, `tenantCompanyId`, `buildingId`, `tenantPicId` | **Lowercase canonical UUIDs only.** The signature covers the exact wire form. |
| `appointmentVersion` | Integer ≥ 1. Must equal the PROPOSED version. |
| `kind` | `INSPECTION` or `EXECUTION`. Must equal the appointment kind. |
| `tenantUserReference` | Opaque BM user reference (1–128). Provenance only, grants no authority. |
| `selectedStartAt`, `selectedEndAt` | Offset timestamps, end > start. Must equal the PROPOSED slot exactly (instant comparison). |
| `bmConsentEvidenceId` | BM-issued, unique per integration (1–128). Never invented by Handyman. |
| `method` | Literal `BM_AUTHENTICATED_TENANT_SELECTION` |

Signature: `sha256=` + HMAC-SHA256 over `stableJson(body)`, using `HANDYMAN_VISIT_SLOT_SECRET_<CODE>`. This secret is **separate** from the handoff secret, so a handoff-scoped secret can never validate a slot choice. Verification is constant-time.

Failure policy: every structural, trust, signature, freshness or integration-scope failure returns **one** 401 `HANDYMAN_VISIT_SLOT_ASSERTION_INVALID`, with no enumeration. It happens before any transaction or tenant resolution.

### Ingest order (`acceptTenantSlotChoice`)

1. Strict parse (closed set).
2. Integration row: `status = 'ACTIVE'` AND `tenant_slot_choice_scope = TRUE` AND secret deployed. Otherwise 401.
3. HMAC verify, then freshness.
4. Tenant identity: PART 02 resolver on `(tenantCompanyId, buildingId, tenantPicId)`. The resolved `tenantPicId` must match. The client is **derived**, never trusted from the payload.
5. One transaction:
   - lock the request (`FOR UPDATE`), then the appointment (`FOR UPDATE`);
   - binding: request matches; client, tenant company, building and kind match the resolved context;
   - state is `PROPOSED` and version matches;
   - slot matches exactly; slot not started;
   - insert consent (one-time use via unique `jti`, unique `bmConsentEvidenceId`, one per appointment, DB guard requires exact PROPOSED match);
   - `UPDATE` to `TENANT_SELECTED`, setting `tenant_choice_evidence_ref` to the consent ID, `version + 1`;
   - audit `HANDYMAN_VISIT_TENANT_SLOT_SELECTED` in the same transaction.
6. Response: `{consentId, appointmentId, handymanRequestId, state: 'TENANT_SELECTED', version, confirmedBooking: false}`. No token, no session, no capacity.

Replays surface as `HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED` (409). A second consent for the same visit surfaces as `HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT` (409).

## 4. Ops confirmation (`POST /api/v1/handyman/requests/:id/visits/:appointmentId/confirm`, body `{version}`)

1. **Authority gate first.** If `tenantSlotConsentAuthorityConfigured` is false, return 409 `HANDYMAN_VISIT_CONFIRMATION_DISABLED` with no lock, no read and no write.
2. Session and building/client scope on the request.
3. Lock request, then appointment. Accept only `TENANT_SELECTED` at the exact version. Replay of a completed confirmation at `version + 1` returns the current record without a second reservation.
4. Consent provenance must exist, be the referenced row, and be at `version - 1`. Otherwise `HANDYMAN_VISIT_SLOT_CONSENT_MISSING`.
5. Slot not started. Live eligibility via the same `assertVisitResourceAdmission` used by proposal.
6. `UPDATE` to `CONFIRMED`, then insert the capacity reservation. `23P01` (overlap) becomes `HANDYMAN_VISIT_CAPACITY_CONFLICT` (409). The 0431 deferred guards then require the reservation to commit with the CONFIRMED visit.
7. Audit `HANDYMAN_VISIT_CONFIRMED` with `actorUserId`, in the same transaction.

Locks are always taken request-then-appointment in both ingest and confirm, so the two paths cannot deadlock.

## 5. BM dependencies (external authority, not implementable by Handyman)

1. **Slot-choice channel.** BM must provide a tenant-authenticated selection step in BM Super App that signs TENANT_SLOT_CHOICE assertions with a key Handyman provisions. BM owns key custody and rotation.
2. **Evidence.** BM issues and retains `bmConsentEvidenceId`, and can show it on request.
3. **Tenant identity mapping.** BM must define how its authenticated tenant user maps to a Handyman `tenant_pics.id`. Handyman will not infer the mapping or create identities.
4. **Tenant read of proposed slots.** BM must show the tenant the Ops-proposed slot so the tenant chooses from what Handyman actually proposed.
5. **Certification before provisioning.** Only after BM certifies items 1–4 may Handyman create the integration row with the scope flag and deploy the secret.

## 6. Open decisions for the business owner

- **Slot model.** This PR implements *exact-slot acceptance* (the tenant accepts the Ops-proposed slot). Alternatives: tenant chooses from several offered slots, or tenant originates a slot. Each needs a different contract.
- **Decline path.** A tenant rejecting a proposal is not designed. A non-confirmed rejection should probably cancel the PROPOSED visit, but that needs an authority decision.
- **CONFIRMED cancellation.** Still MISSING. It needs a reservation-release authority, which the DB permits but no service implements.
- **Ops confirm permission.** The confirm route reuses the R1C proposal gate `tenant_company.manage`. Confirmation is an Operations act, so the correct permission needs an explicit decision before activation.

## 7. Activation gate (all required; none is provisioned here)

- BM certification of §5 items 1–4.
- A `handyman_handoff_integrations` row for the BM integration with `status = 'ACTIVE'` and `tenant_slot_choice_scope = TRUE` (default `FALSE`, no row is granted by migration `0434`).
- `HANDYMAN_VISIT_SLOT_SECRET_<CODE>` deployed.
- Only then does `tenantSlotConsentAuthorityConfigured` return true, which turns on `bookingEnabled` and `confirmationEnabled` in the read path.

## 8. Implemented in this PART (inactive without §7)

| File | Role |
|---|---|
| `src/database/migrations/0434_create_handyman_tenant_slot_consents.ts` (+ `index.ts`) | `tenant_slot_choice_scope` (default FALSE); append-only consent table with unique `(integration, jti)`, `(integration, evidence)`, `(appointment)`; insert guard requiring an exact PROPOSED match; deferred commit guard requiring a consent for TENANT_SELECTED/CONFIRMED |
| `handyman-tenant-slot-assertion.ts` | Pure closed-set parser, scoped secret name, HMAC sign/verify, freshness, instant comparison |
| `handyman-tenant-slot-authority.ts` | Fail-closed `tenantSlotConsentAuthorityConfigured` |
| `handyman-tenant-slot-consent.service.ts` | Ingest (§3), with injectable pool and transaction |
| `handyman-visit-confirmation.service.ts` | Ops confirm (§4) |
| `handyman-tenant-slot-consent.routes.ts` (mounted in `src/routes/index.ts`) | The two endpoints only |
| `handyman-visit-api.service.ts` | Exports shared helpers; extracts `assertVisitResourceAdmission` (used by proposal and confirm); read path derives `bookingEnabled`/`confirmationEnabled` from the authority gate (was hardcoded `false`) |
| `src/shared/errors.ts` | Seven `HANDYMAN_VISIT_*` codes |

The R1C visit router is **unchanged** and still exposes no confirm or select path. `handyman-visit-booking-authority.test.ts` pins this.

## 9. Verification

- `npm run typecheck`: exit 0 (after all edits).
- `tests/handyman-tenant-slot-assertion.test.ts` and `tests/handyman-tenant-slot-consent.test.ts`: **14/14 pass**. They cover the closed-set parser, HMAC scope and tamper, secret isolation, freshness, instant comparison, the authority gate, every ingest trust failure occurring before any transaction, stale version / state / slot / scope / started-slot conflicts with no visit write, replay and one-per-appointment handling, confirm disabled with zero DB access, migration DDL and registration, and router mounting.
- Migration chain applied in a throwaway embedded Postgres: all 434 migrations including 0434. Scope column defaults `false` and is `NOT NULL`; consent triggers and constraints are present; the commit guard is deferred.
- Neighbours run: `handyman-visit-booking-authority` 7/7 (real DB, standalone), `handyman-appointment-persistence` 9/9, `handyman-appointment-core` 19/19, `error-contract` 4/4.

## 10. Residual gaps (honest)

- **Row-level guard behaviour is not executed.** The consent insert guard, append-only trigger and commit guard were verified for presence and DDL, not by inserting rows. A real-Postgres invariant test is the next step before activation.
- **Confirm happy path is not tested.** Only the fail-closed gate is. The positive path needs scope and eligibility fixtures.
- **DB-backed handoff suites skip** in this sandbox (`ensureTestDatabase()` needs a configured test database). They were not used as evidence.
- **Transport-certification suite fails 6/6, both on this branch and on a clean export of the base commit.** The cause is a missing git commit (`b87d72f`, `2fcfad9`) in the clone, which is environmental and unrelated to this PART.
- Tenant decline, CONFIRMED cancellation and the Ops confirm permission (§6) are open.
