# CR-HM-FIELD-ASSIGN-01 PART 01D-2 / 01D-2A — Tenant-originated slot choice and consent authority

Baseline: PART 01D `2bf37fa` and PART 01D-2 `fb09aab` (pushed). This revision is PART 01D-2A, which corrects the slot model from Ops-proposed acceptance to tenant-originated selection. Branch: `arena/bdfa247a-handyman-backend`. Repository guard: `budiirmawan/Handyman-Backend`.

**Status: customer booking confirmation remains DISABLED.** The BM-attested tenant slot-choice authority is not provisioned. `bookingEnabled` and `confirmationEnabled` stay `false` in every environment until BM certifies the channel and Handyman provisions the integration. No integration row is created by any migration.

## 1. Authority decisions

| Question | Decision |
|---|---|
| Who determines the visit date and time? | **The tenant**, in BM Super App. Operations does not set the tenant's schedule. |
| Who selects the freelancer resource? | Handyman Operations, from registered eligible Inspectors or Crew. Operations matches a resource to the tenant's chosen slot. It cannot move the slot. |
| If the tenant's slot is unavailable, who approves the alternative? | **The tenant.** A changed slot must be selected or approved by the tenant through a new BM-attested choice. Operations cannot substitute one. |
| Who proves the tenant acted? | BM. Handyman verifies a BM-signed assertion and records BM's evidence ID. Handyman never infers or invents consent. |
| Is quotation approval booking consent? | **No.** `handyman-quotation-decision.service.ts` covers a quotation version, not a slot, so it is never reused. |
| Is a string `tenant_choice_evidence_ref` consent? | **No.** Consent exists only as an append-only row written from a verified assertion, and it is bound in a separate binding row. |
| Are INSPECTION and EXECUTION separate? | Yes. Consent, binding and pending-choice uniqueness are all per `(request, kind)`. |
| Is a `TENANT_SELECTED` visit confirmed? | **No.** Confirmation is a separate Ops act after the tenant choice, and it needs eligibility and an atomic capacity reservation. |
| Is crew ACTIVE the same as booking confirmed? | No. |

## 2. Slot model (01D-2A)

The tenant originates the slot. Handyman does not need a PROPOSED visit to exist before the tenant chooses. The sequence is:

1. **Tenant chooses a slot in BM Super App.** BM sends a signed TENANT_SLOT_CHOICE assertion. It names the request, kind, tenant company, building, tenant PIC and the exact slot. It names **no appointment**.
2. **Handyman records a request-level consent** (`handyman_visit_tenant_slot_consents`, append-only). If an Ops PROPOSED visit for that request and kind already has the exact slot, Handyman binds the consent to it in the same transaction, which moves the visit to `TENANT_SELECTED`. Otherwise the consent stays **pending** and unbound.
3. **Operations matches an eligible resource** by proposing a visit. If a pending consent exists, the proposal must use exactly the tenant's slot. Otherwise the proposal is refused with `HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT`. When it matches, the proposal is inserted as PROPOSED, bound, and moved to `TENANT_SELECTED` in one transaction.
4. **Ops confirms** (§5). Only then is the visit `CONFIRMED`, with a capacity reservation.

Rules that keep the states honest:

- At most one **pending** (unbound) consent per `(request, kind)`, enforced by a DB insert guard.
- No new consent for a `(request, kind)` that already has a live `TENANT_SELECTED`, `CONFIRMED` or `IN_PROGRESS` visit.
- A consent binds only to a PROPOSED visit whose kind, request, tenant company, building, **and exact slot** match. The DB binding guard enforces this, together with the PROPOSED state and the appointment version.
- A `TENANT_SELECTED` (or later) visit must cite a **bound** consent. A deferred commit guard enforces this, so a string reference cannot commit.
- Bindings and consents are append-only. UPDATE and DELETE raise `23514`.
- No parallel booking state. The existing `PROPOSED → TENANT_SELECTED → CONFIRMED → IN_PROGRESS → COMPLETED` engine from 0431 is unchanged.

## 3. Identity binding (never trust a caller `tenantPicId`)

The request's **stored** tenant identity is authoritative: `handyman_service_requests.(client_id, tenant_company_id, building_id, tenant_pic_id)`.

- The ingest service resolves the claimed `(tenantCompanyId, buildingId, tenantPicId)` through the PART 02 resolver. This proves the PIC is ACTIVE and belongs to the company and building.
- The request row is locked. Its stored `tenant_company_id`, `building_id` and `tenant_pic_id` must equal the claim. If the request's stored PIC is null, or differs from the claim, the result is **401 `HANDYMAN_VISIT_SLOT_ASSERTION_INVALID`**, with no enumeration.
- The consent insert guard in the database repeats this check on every insert. A consent for a PIC other than the request's PIC cannot be written, even by a caller that bypasses the service.
- The client is derived from the request, never from the payload.

Limit: there is still **no tenant session principal**. The PIC is proven by BM's signed claim plus the request binding. The BM mapping from a tenant user to a `tenant_pics.id` is an external dependency (§7).

## 4. Assertion contract (BM → Handyman, server-to-server)

Endpoint: `POST /api/v1/handyman/integrations/tenant-slot-choices`. No user session. Header: `x-handyman-tenant-slot-signature: sha256=<hex>`.

Body (closed set, all required, no extra members):

| Field | Rule |
|---|---|
| `iss` | BM integration code (1–64). Selects the integration row and its secret. |
| `aud` | Literal `handyman-backend` |
| `purpose` | Literal `TENANT_SLOT_CHOICE` |
| `jti` | 16–128 chars, unique per integration (one-time use) |
| `iat`, `exp` | RFC 3339 with explicit offset. `exp - iat` ≤ 300 s. `iat` ≤ now + 60 s. `exp` > now. |
| `handymanRequestId`, `tenantCompanyId`, `buildingId`, `tenantPicId` | **Lowercase canonical UUIDs only.** The signature covers the exact wire form. |
| `kind` | `INSPECTION` or `EXECUTION` |
| `tenantUserReference` | Opaque BM user reference (1–128). Provenance only, grants no authority. |
| `selectedStartAt`, `selectedEndAt` | Offset timestamps, end > start. The exact slot the tenant chose. |
| `bmConsentEvidenceId` | BM-issued, unique per integration (1–128). Never invented by Handyman. |
| `method` | Literal `BM_AUTHENTICATED_TENANT_SELECTION` |

There is **no `appointmentId` and no `appointmentVersion`**. The tenant chooses a slot for a request, not for an appointment Ops may not yet have made.

Signature: `sha256=` + HMAC-SHA256 over `stableJson(body)`, using `HANDYMAN_VISIT_SLOT_SECRET_<CODE>`. This secret is **separate** from the handoff secret, so a handoff-scoped secret cannot validate a slot choice. Verification is constant-time.

Failure policy: every structural, trust, signature, freshness, integration-scope or identity failure returns **one** 401 `HANDYMAN_VISIT_SLOT_ASSERTION_INVALID`, with no enumeration. Structural, trust and freshness failures happen before any transaction or resolution.

### Ingest order (`acceptTenantSlotChoice`)

1. Strict closed-set parse.
2. Integration row: `status = 'ACTIVE'` AND `tenant_slot_choice_scope = TRUE` AND the secret is deployed. Otherwise 401.
3. HMAC verify, then freshness.
4. Resolver on the claimed `(tenantCompanyId, buildingId, tenantPicId)`. The resolved PIC must equal the claim.
5. One transaction:
   - lock the request (`FOR UPDATE`) and check its stored tenant binding (§3);
   - replay check: `jti` or `bmConsentEvidenceId` already recorded for this integration → 409 `HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED`;
   - slot not started;
   - no live `TENANT_SELECTED`, `CONFIRMED` or `IN_PROGRESS` visit for the kind, and no other pending consent for the kind (409 `HANDYMAN_VISIT_STATE_CONFLICT` or `HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT`);
   - insert the consent (DB guard repeats the binding and pending-uniqueness checks);
   - if a live PROPOSED visit has exactly this slot, bind (`handyman_visit_tenant_slot_bindings`) and move it to `TENANT_SELECTED` with `version + 1`, setting `tenant_choice_evidence_ref` to the consent ID;
   - audit `HANDYMAN_VISIT_TENANT_SLOT_SELECTED` (bound) or `HANDYMAN_VISIT_TENANT_SLOT_RECORDED` (pending), in the same transaction.
6. Response: `{consentId, handymanRequestId, kind, selectedStartAt, selectedEndAt, bound, appointment, confirmedBooking: false}`. No token, no session, no capacity.

A replay of an already-bound choice is refused. A second pending choice for the same kind is refused. Neither writes anything.

## 5. Ops proposal and confirmation

### Proposal (existing endpoint, binding added)

Within the proposal transaction, after the request lock:

- If a **pending** consent exists for the kind, the proposed slot must equal its exact slot. Otherwise 409 `HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT`. Ops cannot move the tenant's slot.
- If it matches, the proposal inserts PROPOSED, binds the pending consent, and moves to `TENANT_SELECTED`, all in one transaction.
- If there is no pending consent, the proposal path is unchanged. The visit stays PROPOSED until the tenant chooses it.

### Confirmation (`POST /api/v1/handyman/requests/:id/visits/:appointmentId/confirm`, body `{version}`)

1. **Authority gate first.** If `tenantSlotConsentAuthorityConfigured` is false, return 409 `HANDYMAN_VISIT_CONFIRMATION_DISABLED` with no lock, no read and no write.
2. Session and building/client scope on the request.
3. Lock request, then appointment. Accept only `TENANT_SELECTED` at the exact version. A replay of a completed confirmation returns the current record without a second reservation.
4. The visit must cite a **bound** consent: the binding row must exist for this appointment, and its `appointment_version` must equal `version - 1`. Otherwise `HANDYMAN_VISIT_SLOT_CONSENT_MISSING`.
5. Slot not started. Live eligibility via the same `assertVisitResourceAdmission` used by proposal.
6. `UPDATE` to `CONFIRMED`, then insert the capacity reservation. `23P01` (overlap) becomes `HANDYMAN_VISIT_CAPACITY_CONFLICT` (409). The 0431 deferred guards then require the reservation to commit with the CONFIRMED visit.
7. Audit `HANDYMAN_VISIT_CONFIRMED` with `actorUserId`, in the same transaction.

Locks are always taken request-then-appointment in both ingest and confirm, so the two paths cannot deadlock.

## 6. Classification (verified against live source)

| Contract | Class | Evidence |
|---|---|---|
| BM handoff trust channel (HMAC, per-integration secret) | EXISTING | `handoff-runtime.*`, `0375` |
| Slot-choice trust channel (separate purpose and secret) | **IMPLEMENTED here, inactive** | `handyman-tenant-slot-assertion.ts`, `handyman-tenant-slot-consent.service.ts` |
| Tenant identity binding to the request (stored company, building, PIC) | **IMPLEMENTED here, inactive** | ingest step 5; consent insert guard in `0434` |
| Tenant identity from a BM tenant session | AUTHORITY BLOCKED | No tenant session principal; BM mapping undefined (§7) |
| Request-level consent provenance (append-only, one-time use) | **IMPLEMENTED here, inactive** | `0434`, `handyman_visit_tenant_slot_consents` |
| Consent-to-visit binding (append-only, exact slot, version) | **IMPLEMENTED here, inactive** | `0434`, `handyman_visit_tenant_slot_bindings`, `handyman-tenant-slot-binding.repository.ts` |
| Pending-choice uniqueness per request and kind | **IMPLEMENTED here, inactive** | `0434` insert guard |
| Commit guard: TENANT_SELECTED or later requires a bound consent | **IMPLEMENTED here, inactive** | `0434` deferred constraint trigger |
| Appointment state, version, slot immutability | EXISTING | `0431` triggers |
| Capacity reservation schema (`btree_gist` exclusion, deferred commit guard) | EXISTING, **function body corrected in `0434`** | `0431` (see §8 finding) |
| Eligible resource matching (Inspector / Crew) | EXISTING | `assertVisitResourceAdmission` |
| Proposal binding to a pending tenant choice | **IMPLEMENTED here, inactive** | `handyman-visit-api.service.ts` |
| Capacity reservation transaction | **IMPLEMENTED here, inactive** | `handyman-visit-confirmation.service.ts` |
| Fail-closed authority gate | **IMPLEMENTED here** | `handyman-tenant-slot-authority.ts` |
| Tenant alternative-slot selection after unavailability | MISSING | BM does not yet show availability (§7) |
| Decline / tenant rejection path | MISSING | Open decision (§8) |
| CONFIRMED cancellation and reservation release | MISSING | Open decision (§8) |

## 7. BM dependencies (external authority, not implementable by Handyman)

1. **Tenant slot-selection step.** BM Super App must let an authenticated tenant choose a date and time for a request, then sign a TENANT_SLOT_CHOICE assertion with a key Handyman provisions. BM owns key custody and rotation.
2. **Availability for the tenant.** BM must show the tenant the slots that are actually available. Handyman has no published availability contract yet. Without one, the tenant may choose a slot Operations cannot match, and the consent stays pending until Operations finds a match. This is an open contract, not an implementation gap.
3. **Alternative after unavailability.** If the chosen slot is unavailable, BM must return the decision to the tenant. Only a new tenant-signed choice can replace the pending one. Handyman does not create alternatives.
4. **Evidence.** BM issues and retains `bmConsentEvidenceId`, and can show it on request.
5. **Tenant identity mapping.** BM must define how its authenticated tenant user maps to a Handyman `tenant_pics.id`. Handyman will not infer the mapping or create identities.
6. **Certification before provisioning.** Only after BM certifies items 1–5 may Handyman create the integration row with the scope flag and deploy the secret.

## 8. Open decisions for the business owner

- **Availability source.** Which system publishes the slots the tenant may choose from (BM, Handyman, or a mix)? This decides whether Handyman must expose an availability contract.
- **Decline path.** A tenant rejecting a proposal is not designed. Should a rejection cancel a PROPOSED visit, and is a pending consent withdrawn by a new tenant choice only?
- **CONFIRMED cancellation.** Still MISSING. It needs a reservation-release authority, which the DB permits but no service implements.
- **Ops confirm permission.** The confirm route reuses the R1C proposal gate `tenant_company.manage`. Confirmation is an Operations act, so the correct permission needs an explicit decision before activation.
- **Pending choice lifecycle.** A pending consent has no expiry. Should a tenant choice that Operations never matches expire, and how is that recorded?

### Finding in migration 0431 (on `main`), corrected in 0434

The capacity commit guard `handyman_visit_capacity_commit_guard()` in `0431` built `appointment_uuid` with one nested `CASE` expression that references `OLD.appointment_id`. That field exists only on `handyman_visit_capacity_reservations`. PL/pgSQL resolves `OLD` against the row type of the table the trigger is attached to, so the deferred trigger on `handyman_visit_appointments` failed with `42703` at COMMIT for **every committed appointment insert or update**. This was reproduced against real PostgreSQL during this PART. The affected proposal path is therefore not committable on `main`. `0431` is already on `main`, so it was not edited. Migration `0434` contains a `CREATE OR REPLACE FUNCTION` with the same invariant written as statement-level branches. Its `down()` restores the original body. This is a bounded correction to the appointment engine. It changes no state, transition or invariant. The fix ships in `0434` because `0434` is still unmerged on `main`.

## 9. Activation gate (all required; none is provisioned here)

- BM certification of §7 items 1–5.
- A `handyman_handoff_integrations` row for the BM integration with `status = 'ACTIVE'` and `tenant_slot_choice_scope = TRUE` (default `FALSE`; no migration grants it).
- `HANDYMAN_VISIT_SLOT_SECRET_<CODE>` deployed.
- Only then does `tenantSlotConsentAuthorityConfigured` return true. That turns on `bookingEnabled` and `confirmationEnabled` in the read path.

## 10. Implemented in PART 01D-2A (inactive without §9)

| File | Role |
|---|---|
| `src/database/migrations/0434_create_handyman_tenant_slot_consents.ts` | Migration `0434`, unmerged on `main` (main ends at `0433`). Contains `tenant_slot_choice_scope` (default FALSE); append-only request-level consent table; append-only binding table; insert guard (stored tenant binding, pending uniqueness, no selected visit for the kind); binding guard (exact slot, kind, request, version); deferred commit guard; and the corrected 0431 commit guard (§8). |
| `handyman-tenant-slot-assertion.ts` | Pure closed-set parser (v2: no appointment fields), scoped secret name, HMAC sign and verify, freshness, instant comparison |
| `handyman-tenant-slot-authority.ts` | Fail-closed `tenantSlotConsentAuthorityConfigured` |
| `handyman-tenant-slot-binding.repository.ts` | Pending lookup, exact-slot proposal assertion, bind (binding row plus PROPOSED → TENANT_SELECTED), error mapping |
| `handyman-tenant-slot-consent.service.ts` | Ingest (§4) with injectable pool and transaction |
| `handyman-visit-api.service.ts` | Proposal binds a pending choice (§5), with the same admission path |
| `handyman-visit-confirmation.service.ts` | Ops confirm (§5): binding join and `version - 1` |
| `handyman-tenant-slot-consent.routes.ts` (mounted in `src/routes/index.ts`) | The two endpoints only |
| `src/shared/errors.ts` | `HANDYMAN_VISIT_*` codes, including `HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT` (409) and `HANDYMAN_VISIT_STATE_CONFLICT` (409) |

The R1C visit router is unchanged. It exposes no confirm or select path. `handyman-visit-booking-authority.test.ts` pins this.

## 11. Verification (this PART)

- `npm run typecheck`: exit 0, after all edits.
- `tests/handyman-tenant-slot-assertion.test.ts`: **6/6 pass** (closed set, v2 fields, HMAC, freshness).
- `tests/handyman-tenant-slot-consent.test.ts`: **5/5 pass** (no DB). Ingest trust failures occur before any transaction. PIC mismatch returns 401. Migration DDL and router are checked. Confirm is disabled.
- `tests/handyman-tenant-slot-consent-db.test.ts`: **12/12 pass** on a real embedded PostgreSQL with the full migration chain through 0434. Covers:
  - scope default FALSE, and authority requires the grant plus the secret;
  - append-only UPDATE and DELETE on consents;
  - request tenant binding: a caller PIC other than the request PIC is refused (401), and the DB guard refuses it too;
  - replay by JTI and by evidence ID;
  - one pending choice per request and kind (service and DB);
  - exact-slot bind to `TENANT_SELECTED` with a committed evidence reference and binding row;
  - a different slot stays pending and leaves the PROPOSED visit untouched, and Ops cannot match a different slot (409);
  - commit guard: a string reference cannot commit (`23514` at COMMIT);
  - binding guard: slot, version and kind mismatches are refused;
  - rollback: a refused overlapping confirmation leaves the visit at `TENANT_SELECTED`, with no reservation and no audit;
  - the confirmation happy path, with one reservation and one audit row, and idempotent replay;
  - confirm stays disabled while authority is absent, with the visit unchanged.
- The database tests stub only the PART 02 resolver, building scope and resource eligibility. Those are covered by their own suites.

## 12. Residual gaps (honest)

- **Real eligibility and scope are stubbed in the DB tests.** The positive confirm path uses stub admission and scope. The real `assertVisitResourceAdmission` fixtures are not exercised here.
- **Proposals are not driven through `createVisitProposal`.** The DB tests use its exact sequence (lock, pending check, insert, bind) through the repository. Its own admission check is not rerun.
- **The 0434 `down()` is not run.** Only the forward path is executed.
- **Neighbour suites.** `tests/handyman-customer-care-transport-certification.test.ts` and `tests/r11-part07-closure-guard.test.ts` fail 6/6 on this branch and on a clean export of the base commit. The cause is missing git commits `b87d72f` and `2fcfad9` in the clone, which is environmental and unrelated to this PART.
- **Decline, alternative after unavailability, CONFIRMED cancellation and the Ops confirm permission** are open (§8).
- **Availability contract** is not defined (§7 item 2).
