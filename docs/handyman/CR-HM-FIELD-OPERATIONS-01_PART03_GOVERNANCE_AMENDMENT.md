# CR-HM-FIELD-OPERATIONS-01 — PART 03: GOVERNANCE & DESIGN

- **Contract:** HANDYMAN FIELD OPERATIONS — PART 03 (governance & design only)
- **Repository:** `budiirmawan/Handyman-Backend` (only repository touched)
- **Branch:** `arena/a61abf59-handyman-backend`
- **Baseline:** `4eae70e` — PART 02 arrival challenge issuance (CR-HM-FIELD-OPS-ACK-01)
- **Status:** **PROPOSAL — NOT IMPLEMENTED.** No runtime, no route, no migration, no
  OpenAPI, no test added by this PART. Applying anything here is blocked on the
  CR Owner sign-off gate (`CR-HM-FIELD-OPERATIONS-01_PART03_SIGNOFF_GATE.md`).
- **No PR. No Biznet deployment. No full test suite. No frozen feature implemented.**

---

## 1. Frozen-decision review (read-only, before proposing anything)

| Frozen artefact | Clause reviewed | What it freezes | Verdict |
| --- | --- | --- | --- |
| `CR-HM-07_GEOSPATIAL_AUTHORITY_DECISION.md` §10 ADMINISTRATION | “Policy mutations require an authenticated, authorized management context. Exact HTTP/admin UI exposure is **DEFERRED** — no API is invented in this governance PART. Policy changes must preserve history/audit … append/enable pattern, never a silent overwrite.” | Policy mutation is **authorized in principle**, but **no HTTP surface** may be invented by the governance document itself. History-preservation is mandatory. | **G-3 is a deferred exposure, not a forbidden one.** An amendment may add the surface **provided history/audit is preserved** — which 0399 + the PART 03B service already do. |
| `CR-HM-07_GEOSPATIAL_AUTHORITY_DECISION.md` frozen tokens | `REFERENCE_COORDINATE_SOURCE=AUTHORIZED_OPERATOR_CONFIGURATION`, `GEOFENCE_RADIUS_SOURCE=PER_BUILDING_POLICY`, `GEOFENCE_COMPUTATION_AUTHORITY=HANDYMAN_BACKEND`, `API_CO_ID_GEOMETRY_AUTHORITY=NO` | Coordinates/radius/thresholds come from operator configuration; computation is Backend-only; provider has zero geometry authority. | **Compatible** with G-3. The proposal exposes exactly the operator configuration and nothing else. |
| `CR-HM-07_PART03_LOCATION_SIGNAL_GOVERNANCE.md` §3 | Geofence is a **RISK/CORROBORATION SIGNAL only**; bounded vocabulary `INSIDE / OUTSIDE / LOW_ACCURACY / UNAVAILABLE`; “Geofence alone NEVER produces a VERIFIED/FAILED verdict”. | Signal ≠ verdict. | **Compatible.** A configuration write cannot produce a verdict; §6 of the test plan proves it. |
| `CR-HM-07_PART03_LOCATION_SIGNAL_GOVERNANCE.md` §11 FIREWALL | Must NOT “change the PART 02 QR registry”, consume challenges, start work, write attendance, touch payment/BAST/FM. | That firewall binds **API.CO.ID / enrichment** (the subject of that document). It is not a prohibition on the registry owner itself: PART 02 §“create/deactivate” already ships registry mutation as an **internal, realm-guarded** operation. | **Compatible** — G-2 exposes an existing registry mutation; it does not let enrichment change the registry. |
| `CR-HM-07_PART04_ARRIVAL_RESULT_GOVERNANCE.md` §5, §8 | `QR_MATCH_REQUIRED_FOR_VERIFIED=YES`; `FAILED` reason set is exactly `QR_MISMATCH`, `GEOFENCE_OUTSIDE`, `ACTOR_ASSIGNMENT_INVALID`; `MANUAL_REVIEW_REQUIRED` set includes `QR_UNKNOWN`, `QR_INACTIVE`, `NO_GEOSPATIAL_POLICY`. | Exact verdict/reason vocabulary. | **Compatible with G-2/G-3** (they make `MATCH` and a policy *attainable*; the vocabulary is untouched). **G-4 conflicts** — see §2.3. |
| `CR-HM-07_FINAL_CERTIFICATION.md` §8, §10 | Certified terminal statuses/reasons; “no duplicated decision logic in route/controller”. | Certified contract. | **G-2/G-3 compatible.** **G-4 requires a documented amendment** to certification §8 (narrowing only). |
| `CR-HM-07_START_GOVERNANCE.md` §D/§F | Arrival actor = authenticated local session user; caller-supplied `workerId/crewId` never trusted; Lead resolved server-side. | No worker self-authorization. | **Honoured by all three amendments**: none of them lets a field actor configure its own evidence. |
| Migration `0397` (challenge lifecycle) | `CHECK (status IN ('PENDING','CONSUMED','EXPIRED'))`; UPDATE allowed only `PENDING→CONSUMED/EXPIRED`; one live PENDING per (scope, actor). | No `REVOKED`/`SUPERSEDED` challenge status. | **Constrains G-4**: the guard must be a *refusal*, not a new lifecycle state. Proposal respects this (§2.3). |
| Migration `0396` (scope assignment) | `CHECK (status IN ('ACTIVE','SUPERSEDED'))`; only `ACTIVE→SUPERSEDED`; one ACTIVE per scope. | A superseded assignment is a durable, queryable fact. | **Enables G-4** without new schema: the guard reads the bound `assignment_id` vs the ACTIVE row. |
| Migration `0398` (QR registry) | `status IN ('ACTIVE','INACTIVE')`; `opaque_code_hash` unique; hierarchy triggers; DELETE blocked; UPDATE only `ACTIVE→INACTIVE`. | Registry is already complete for G-2. | **Zero migration needed** for G-2. |
| Migration `0399` (geofence policy) | One `ACTIVE` per Building (partial unique index); history via `INACTIVE`; physical bounds CHECKs. | Policy persistence is already complete for G-3. | **Zero migration needed** for G-3. |

**Review conclusion:** G-2 and G-3 are *deferred exposure of already-implemented, already-guarded authority* — not new business capability. G-4 is the only item that touches a **certified** contract, and only by narrowing it.

---

## 2. Problem statements (evidence-backed)

### 2.1 G-2 — QR registration/deactivation has no HTTP surface

`createHandymanArrivalLocationIdentifier` / `deactivateHandymanArrivalLocationIdentifier`
exist with full validation (hierarchy, ACTIVE masters, BE-02G exact-Building,
generated opaque value, hash at rest, journal). **No router mounts them**
(`grep` over `src/routes/**` and every `*.routes.ts`: zero hits). Measured
consequence, from PART 02 §3: with no registered identifier, every terminal
evaluation resolves `QR_UNKNOWN` → `MANUAL_REVIEW_REQUIRED`, and **`VERIFIED` is
unreachable in production**, which in turn leaves the CR-HM-08 `CHECK_IN` gate
(requires an immutable `VERIFIED` result) unreachable.

### 2.2 G-3 — Building geofence policy has no HTTP surface

`saveHandymanBuildingGeospatialPolicy` / `getHandymanBuildingGeospatialPolicy`
exist (validation → BE-02G → single transaction, retire-then-insert,
`REPLACED`/`CREATED` journalling, one-ACTIVE index). **No router mounts them.**
Consequence: `NO_GEOSPATIAL_POLICY` (or `GEOFENCE_UNAVAILABLE`) for every
Building, so the geofence chain can never contribute `INSIDE`.

### 2.3 G-4 — a superseded challenge is still *evaluable*

Measured behaviour today (`handyman-arrival-evaluation.test.ts` case 6, PART 02
test 5): a Lead's challenge survives reassignment as `PENDING`; when the
*superseded* Lead submits it, the evaluator returns **`200 FAILED /
ACTOR_ASSIGNMENT_INVALID`** and **consumes the challenge**. Security posture is
fail-closed (never `VERIFIED`), but three things are undesirable:

1. the evaluator performs actor/QR/geofence work against evidence bound to a
   dead assignment;
2. the response cannot distinguish “wrong person submitted the token” from “this
   token is dead because Operations reassigned the job” — the mobile client
   cannot tell the worker “ask Operations to reissue”;
3. a *replacement* Lead who mistakenly holds the superseded token gets the same
   verdict as an attacker.

The G-4 guard refuses **before** any evaluation, with **no** consume and **no**
result row, while leaving every other terminal outcome untouched.

---

## 3. Amendment scope — exactly what changes

| Item | Amendment | Frozen text touched |
| --- | --- | --- |
| G-2 | Add `POST /handyman/buildings/{buildingId}/arrival-location-identifiers`, `GET` (list), `POST .../{identifierId}/deactivate` | `GEOSPATIAL_AUTHORITY_DECISION §10` deferral (exposure only). No authority token changes. |
| G-3 | Add `PUT /handyman/buildings/{buildingId}/geofence-policy`, `GET .../geofence-policy`, `GET .../geofence-policy/history` | Same §10 deferral. History read is required *by* §10, not optional. |
| G-4 | Add refusal `409 HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED` to the **existing** terminal command, before evaluation | `CR-HM-07_FINAL_CERTIFICATION §8` narrows; `PART04 §8` reason set unchanged. |
| Everything else | **Unchanged.** `0397`–`0400` schema, challenge lifecycle vocabulary, QR signal vocabulary, verdict/reason vocabulary, all 288 existing Handyman operations, PR #58 Notification Engine. | — |

**Six new operations** (3 for G-2, 3 for G-3) would move the Handyman surface
`288 → 294`. G-4 adds **zero** operations (existing path, new refusal). Both
figures are recorded here so the reviewer can verify the delta at implementation.

---

## 4. RBAC design — existing Backend RBAC only

### 4.1 Codes reused (no new code, no new role, no new persona)

| Operation | Permission | Why this code |
| --- | --- | --- |
| Register identifier | `building_configuration.manage` | Existing Building-scoped administration code; already used by operational settings, branding, CMS, checklist administration. |
| List identifiers | `building_configuration.read` | Read counterpart of the same family. |
| Deactivate identifier | `building_configuration.manage` | Same management authority; lifecycle write. |
| Write geofence policy | `building_configuration.manage` | Same. |
| Read active policy | `building_configuration.read` | Same. |
| Read policy history | `building_configuration.read` | Same. |

Both codes already exist in `FOUNDATION_PERMISSIONS` (`foundation-access.seed.ts`
lines 640–641) and are already granted to `PLATFORM_ADMIN` by the foundation
seed. **No seed change, no permission migration, no role-permission grant.**

### 4.2 Two-layer wall (both required, in this order)

```text
authenticationMiddleware                       → 401 if unauthenticated
  → requirePermission('building_configuration.manage' | '.read')  → 403 if absent
    → service-level BE-02G exact-Building guard (assertBuildingScopedResourceAccess) → 403 BUILDING_ACCESS_DENIED
      → parameter validation (whitelist parser)   → 400
        → existing service (unchanged authority)  → mutation in ONE transaction
```

RBAC alone is **never** sufficient: `building_configuration.manage` is
Client-wide in intent, so a manager of Building A must not configure Building B.
That is why the existing service-level BE-02G guard stays authoritative and why
the routes must not bypass it (mirrors `building-configuration.routes.ts`,
which documents “Permission checks are followed by BE-02G Building scope
enforcement”).

### 4.3 Access matrix (existing personas only)

| Persona (existing) | `building_configuration.manage`? | Exact-Building? | G-2 register/deactivate | G-3 write | G-2/G-3 read | Terminal verify (unchanged) |
| --- | --- | --- | --- | --- | --- | --- |
| PLATFORM_ADMIN | Yes (foundation seed) | Only for assigned Buildings | ✅ assigned Building | ✅ assigned Building | ✅ | — |
| Client/Building administrator (tenant role granted the code) | Yes (when granted) | Only for assigned Buildings | ✅ assigned Building | ✅ assigned Building | ✅ | — |
| Same-Client sibling-Building manager | Yes | **No** (BE-02G) | ❌ 403 `BUILDING_ACCESS_DENIED` | ❌ 403 | ❌ 403 | — |
| Cross-Client manager | No/Yes | No | ❌ 403 | ❌ 403 | ❌ 403 | — |
| Field Crew Lead (`PIC_PEKERJAAN`) | **No** — field personas are resolved by server-side authority, not tenant RBAC (proof: P0-A field reads exist precisely because workers hold no privileged permission) | n/a | ❌ 403 | ❌ 403 | ❌ 403 | ✅ own scope only (unchanged) |
| Field Inspector | No | n/a | ❌ 403 | ❌ 403 | ❌ 403 | ❌ not Lead |
| Crew helper | No (no login) | n/a | ❌ 401/403 | ❌ 401/403 | ❌ | ❌ |
| Tenant PIC | No | n/a | ❌ 403 | ❌ 403 | ❌ 403 | — |
| Anonymous | — | — | ❌ 401 | ❌ 401 | ❌ 401 | ❌ 401 |

**No worker self-authorization:** a field actor can never create/modify the
evidence that gates its own arrival. Registering a QR or setting a geofence is
strictly an operations/administration act, and it is **not** a field actor
capability anywhere in this design. The worker's only arrival capability remains
the unchanged `POST .../arrival-challenge` + `POST .../arrival-verification`.

### 4.4 Alternative considered and deferred to the gate

**Option B (stricter, NOT proposed by default):** register
`handyman.arrival.configuration.manage` / `.read` and place the manage code in
`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` (the existing mechanism used for
`handyman.qc.configure`), so the authority is never inherited even by
`PLATFORM_ADMIN` and must be granted as a deliberate act.

- **Why not default:** the mandate is “use existing Backend RBAC”; Option B is a
  permission-registry change (new codes + seed + per-tenant grants) and a larger
  blast radius for zero *new* capability.
- **Why it is a real question:** geofence coordinates decide `INSIDE`/`OUTSIDE`,
  which is a component of the `VERIFIED` verdict. A reviewer may prefer the
  deliberate-grant discipline for exactly this reason.
- **Decision owner:** CR Owner at the sign-off gate (gate item **SG-2**).
  Default if unopposed: **Option A** (reuse `building_configuration.*`).

---

## 5. Design decisions

- **D-1 — Expose, don't re-implement.** Every G-2/G-3 handler calls the existing
  service verbatim; handlers are thin (auth → RBAC → whitelist parse → service →
  bounded serialization). No validation, ordering, hierarchy or authorization
  rule is duplicated, so the internal and HTTP paths cannot drift. This mirrors
  the PART 02 precedent (`arrival-challenge` shell).
- **D-2 — Whitelist-only caller input.** G-2 accepts the location chain only;
  `clientId`, `status`, `id`, `opaqueCode`, `opaqueCodeHash` are derived
  server-side and structurally ignored. G-3 accepts the five policy values +
  optional `effectiveFrom`; `buildingId` comes from the URL and `clientId`,
  `status`, `createdByUserId` are derived. Journey-shaped smuggling is refused
  by construction (`parse` returns a literal object).
- **D-3 — Secret handling unchanged.** The opaque QR value is returned **exactly
  once** (201) and never again: list/get/deactivate projections omit both the
  value and the hash. No token or hash enters a journal, log or error message.
- **D-4 — History is the audit surface (frozen §10).** Replacement stays
  retire-then-insert with `REPLACED`/`CREATED` operational events; the history
  endpoint exposes every retired row. DELETE stays blocked by the 0398/0399
  triggers — no handler attempts it.
- **D-5 — 404 before 403 where a row must be loaded.** `GET active policy`
  returns 404 for an unconfigured Building *before* any row-based authorization,
  so a foreign caller cannot distinguish “not configured” from “not yours”.
  (This is the pre-existing service ordering; the HTTP layer preserves it.)
- **D-6 — G-4 is a refusal, not a lifecycle change.** No `REVOKED`/`SUPERSEDED`
  challenge status is added (0397 CHECK untouched). The guard: after the replay
  short-circuit and before actor/QR/geofence work, compare the challenge's
  `assignment_id` with the scope's current `ACTIVE` assignment (0396). If the
  bound assignment is no longer ACTIVE → `409
  HANDYMAN_ARRIVAL_CHALLENGE_SUPERSEDED`, **no consume, no result row**; the
  challenge expires naturally at TTL. Replay of an already-recorded result is
  still returned unchanged, so device idempotency is preserved.
- **D-7 — G-4 is additive to, not a replacement for, the certified verdict.**
  A *different* actor bound to a **still-ACTIVE** assignment keeps the certified
  `FAILED / ACTOR_ASSIGNMENT_INVALID`. Only the “token bound to a dead
  assignment” case changes (from a 200 verdict to a 409 refusal).
- **D-8 — Configuration never implies a verdict.** Writing a policy or
  registering a QR creates no arrival result, consumes no challenge, and never
  makes any actor “arrived”. The CR-HM-07 firewall
  (`ARRIVAL VERIFIED ≠ CHECK-IN ≠ WORK ≠ BILLABLE`) is untouched.

### Rejected alternatives

| Rejected | Why |
| --- | --- |
| Add `REVOKED`/`SUPERSEDED` to challenge status + revoke on reassignment | Schema + certified-lifecycle change; the refusal achieves the same security outcome with zero migration and keeps replay/expiry semantics intact. |
| Let the replacement Lead inherit the superseded challenge | Weakens assignment binding; the new Lead can issue a fresh challenge immediately (PART 02 D-3). |
| Auto-create a default geofence policy per Building | Would invent operator authority and forge `INSIDE`; frozen tokens require `AUTHORIZED_OPERATOR_CONFIGURATION`. |
| Return the QR value again from a “get” endpoint for reprinting | Defeats hash-at-rest; re-register + deactivate is the safe path. |
| New `handyman.arrival.configuration.*` codes by default | Not “existing RBAC”; kept as gate **SG-2** for the owner. |
| Tenant/building-admin UI bundling into one endpoint | Extra surface for no authority gain; keep one operation per existing service call. |
| Let the worker register the QR of their own job | **Prohibited.** Worker self-authorization would let an actor manufacture the evidence gating its own `VERIFIED`. |

---

## 6. Blast radius at implementation (for the reviewer)

| Area | Expected delta |
| --- | --- |
| New module | `src/modules/handyman-arrival-configuration/**` (controller, routes, validation, types, index) — one module, no duplicate authority |
| `src/routes/index.ts` | One `router.use(...)` mount |
| `docs/api/openapi.yaml` | +6 operations (288 → 294), +5 schemas, +1 path parameter; G-4 adds one error code to an existing `x-error-codes` list |
| Migrations | **ZERO** |
| Permissions / seed | **ZERO** (Option A). Option B would need seed + registry changes |
| Notification Engine (PR #58) | **ZERO** |
| Existing tests to re-run | `handyman-geospatial-policies`, `handyman-geospatial-policy-scope-guard`, `handyman-arrival-locations`, `handyman-arrival-location-scope-guard`, `handyman-arrival-verification-api`, `handyman-arrival-evaluation`, `handyman-field-ops-ack-part02`, `handyman-contract-freeze-03-openapi`, `openapi-contract`, `mobile-openapi-completeness` |
| Frozen docs to amend at implementation | `CR-HM-07_GEOSPATIAL_AUTHORITY_DECISION.md §10` (deferral → delivered), `CR-HM-07_FINAL_CERTIFICATION.md §8` (narrow for G-4) |

---

## 7. Security test plan

A full negative/positive plan is in
`CR-HM-FIELD-OPERATIONS-01_PART03_SECURITY_TESTS.md` — **25 cases**, zero silent
skips required, covering: RBAC denial, BE-02G sibling/cross-client denial,
privilege smuggling, worker self-authorization, secret non-recovery, history
preservation, verdict non-effect, and the G-4 superseded refusal invariants.

---

## 8. Non-goals of this PART

- ❌ No runtime, route, controller, migration, OpenAPI change, or test added.
- ❌ No frozen feature implemented; nothing is un-deferred by this document.
- ❌ No new role, persona, permission code (Option B is a *gate question*).
- ❌ No worker self-authorization; no arrival verdict, check-in, attendance,
  billing, BAST or FM coupling.
- ❌ No admin/mobile UI design, no Biznet deployment, no PR.

---

## 9. Sign-off

Approval checklist, approvers and the exact consequences of approval/rejection
are in `CR-HM-FIELD-OPERATIONS-01_PART03_SIGNOFF_GATE.md`. **Implementation does
not start until that gate is signed.**
