# CR-HM-BM-CARE-AUTH-01 — Building Customer Care Authority

**Status:** Authority A implemented and validated. Authority B **BLOCKED**.
**Repository:** `budiirmawan/Handyman-Backend`
**Supersedes nothing.** It is a correction + narrow addition on top of merged PR #34.

---

## 1. Verified Git State (fetched, not assumed)

| Fact | Value |
|---|---|
| PR #34 state | `MERGED` |
| PR #34 head SHA | `496d07f21f95e3776b19ae33a817643447ac8f53` |
| **PR #34 merge commit SHA** | **`08f0c15ff93f6fa8f6e727605d18b308f1d66ee3`** |
| PR #34 merged at | `2026-10-16T10:30:32Z` |
| **`origin/main` after `git fetch`** | **`08f0c15ff93f6fa8f6e727605d18b308f1d66ee3`** (identical to the merge commit — no later commits) |

The previously-circulated value `3b0313c7` is **stale** and is not reported as current.

### Artifacts that were believed present but are NOT in merged main

Verified by direct inspection of `08f0c15`:

- **Migration 0449 does not exist.** The highest migration is
  `0448_handyman_finance_authority_permissions`. `0449` is therefore **unclaimed**.
- **No `handyman-care-decisions` module exists.**
- **No `handyman_care_decisions` table exists.**
- No `POST /handyman/care-decisions` route was ever registered.

There were no untracked files to preserve (`git status` clean at fetch time).
Migration `0449` is deliberately left **unclaimed and reserved** for the Care
Decisions schema; this change adds `0450` instead so the two can never be
confused.

---

## 2. Business Baseline

```
TENANT / PIC  ↔  CUSTOMER CARE BUILDING  ↔  HANDYMAN
```

The Building Customer Care actor is the operational bridge. The Tenant/PIC
holds no Handyman account and needs none (SD-18). Building Care authenticates
to the Backend and mediates.

Two authorities are separated and must never be conflated:

| | Establishes | Status |
|---|---|---|
| **Authority A** | *Who* the Care actor is, and *which exact Building* they may mediate | **IMPLEMENTED** |
| **Authority B** | *Whether* a Tenant approved a Quotation, Variation or BAST | **BLOCKED** |

---

## 3. Design Governance Correction

`CR-HM-BAST-SIGN-00_Unresolved_Decisions.md` marked SD-01…SD-15 **"Approved"**.
That label was **not** a business approval: the same document describes those
values as *"Default (This Session)"* and states they *"can be revised by
product/organization before implementation begins"*. No Product Lead, Security
Lead, Ops Lead or Legal sign-off exists anywhere in the repository — the only
approval evidence was self-declared inside the document itself.

**An Arena-selected default is not business approval.**

| Range | Corrected status | Basis |
|---|---|---|
| SD-01…SD-10, SD-12…SD-15 | **Proposed** | Session default only; no demonstrable authority |
| SD-11 | **Pending** (Legal) | Already pending; unchanged |
| **SD-16…SD-19** | **Approved** | Restate established business/security principles; no new policy invention |

**Runtime consequence.** Nothing marked Proposed or Pending is built into
runtime authority. Specifically kept **out** of any implemented authority:

- ECDSA / PSrE signature policy (SD-01, SD-03, SD-11, SD-13)
- Optional-evidence relaxation (SD-05)
- Step-up waiver and internal bypass (SD-06, SD-07)
- Warranty auto-start on ACCEPT (SD-08)

Corrections were applied narrowly to
`CR-HM-BAST-SIGN-00_Unresolved_Decisions.md` and
`CR-HM-BAST-SIGN-00_Deliverables_Matrix.md` (status column + rationale headings
+ a correction banner). No other section of those documents was altered.

---

## 4. Authority A — What Is Verified

`resolveBuildingCareAuthority()` — `src/modules/handyman-care-authority/`

| # | Check | Mechanism |
|---|---|---|
| 1 | **Authenticated real Care actor** | `req.auth.userId` from the Backend session only. Account must exist and be `ACTIVE` (INVITED / INACTIVE / SUSPENDED denied). No Care identity is minted, inferred or defaulted. |
| 2 | **Explicit Care permission** | Effective permissions from the BE-01E resolver must include the dedicated `handyman.care.building`. |
| 3 | **ACTIVE assignment to the exact Building** | BE-02F `resolveBuildingsForUser` — already filters ACTIVE `user_building_assignments` **and** ACTIVE buildings, so a revoked/never-granted assignment simply is not in the set. Exact Building id match; **no same-Client sibling shortcut**. |
| 4 | **Correct company/client/building scope** | Client is derived from the actor's **own** assignment chain (Building → Property → Client), never from the request. A caller-supplied `clientId` may only be *narrowed against* the derived value. |
| 5 | **No `tenant_company.manage` substitute** | The resolver never consults it. Generic tenant-company administration has a different blast radius and must not imply the Care bridge. |
| 6 | **No trust in `recordedByUserId` (SD-19)** | The resolver accepts only session-derived input. A browser-supplied recording identity is **rejected** (400), not silently ignored, so no client can believe it was honoured. |
| 7 | **No Care impersonation of Tenant/PIC** | `tenant_pics` is never read. No Tenant/PIC identifier can appear in the result — `capabilities.mayActAsTenantPic` is a `false` **type literal**, so the bridge cannot present itself as the Tenant. |

**Fail-closed and non-enumerating.** Missing permission is reported by the
route middleware as `PERMISSION_DENIED`; every *scope* defect — no ACTIVE
assignment, revoked assignment, INACTIVE Building, wrong asserted Client,
cross-tenant attempt — collapses into the single
`HANDYMAN_CARE_AUTHORITY_DENIED` (403) with one message. Distinct codes would
be a Building/Client enumeration oracle across tenants.

### 4.1 What was REUSED (no parallel mechanism invented)

| Concern | Existing asset reused |
|---|---|
| Identity / session | `authenticationMiddleware` → `req.auth.userId` (`sessionService.resolveSessionContext`) |
| Permission resolution | `permissionService.resolvePermissionsForUser` (BE-01E, single source of truth) |
| RBAC middleware | `requirePermission(...)` |
| Building assignment + ACTIVE membership | `resolveBuildingsForUser` (BE-02F) — `user_building_assignments` (migration 0019) |
| Client/Building isolation | Building → Property → Client chain (`resolveBuildingsForUser`) |
| Capability catalogue | `permissions` table; canonical registration by migration + `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` |
| Error envelope | `AppError` / `sendSuccess` / `sendAppError` |

### 4.2 What was ADDED (minimum required)

1. **Migration `0450_handyman_care_building_authority_permission`** — registers
   exactly one permission, `handyman.care.building`. Additive, no table, no
   column. Granted to **no role** by the migration or by the foundation seed
   (`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`) — not even `PLATFORM_ADMIN`.
   Follows the `handyman.bast.manage` (0446) and `handyman.finance.manage`
   (0448) precedents.
2. **Module `src/modules/handyman-care-authority/`** — resolver, errors,
   validation, one GET route.

**Why the permission was genuinely missing:** the only prior `CUSTOMER_CARE`
concept lives in the BM handoff integration model
(`handyman_handoff_integrations.actor_capability`,
`handyman_handoff_care_actors`, migrations 0425–0430). Those rows identify a
Care operator *inside a BM integration* and carry **no local user, no session,
no RBAC role and no Building assignment**, so they cannot express "this
authenticated Backend actor may mediate THIS Building". Nothing in
`permissions` covered it either.

---

## 5. BM Care Authentication Boundary — Explicit Limitation

The BM Super App Care actor registry **is real and integration-signed**
(`resolveCareActorClaim` in `src/modules/handyman-care-actors/`). It is **not
connected to Backend session authentication**.

**Actual Care identity source for Authority A: the Backend session
(`BACKEND_SESSION`).** Every response carries `bmCareActorBinding: null` so the
limitation is machine-readable rather than silently assumed away.

No fake Care identity is minted from the BM registry, and no generic
authenticated user is silently authorized as Care.

---

## 6. Authority B Remains Blocked

`POST /handyman/care-decisions` is **not registered** — it 404s. The
`handyman_care_decisions` table remains uncreated and migration `0449` remains
unclaimed.

**RBAC working is not a reason to activate it.** Authority B needs both:

1. a **decided commercial-decision authority** — who may assert that a Tenant
   approved a Quotation, Variation or BAST; and
2. a **verified evidence contract** — what proves that approval.

Neither exists. Per SD-17 a Care decision is neutrally recorded and must never
trigger quotation APPROVE, variation APPROVE or BAST ACCEPT.

---

## 7. Backend → Frontend Handoff Contract

Base: `/api/v1`. All requests require `Authorization: Bearer <session token>`.

### 7.1 `GET /handyman/care/buildings/:buildingId/authority`

Resolves Authority A for the session actor. **Read-only.**

**Query parameters**

| Name | Required | Notes |
|---|---|---|
| `clientId` | optional | Narrowing assertion only. Must equal the server-derived Client or the request is denied. Can never widen or redirect scope. |

**No request body.** Supplying any identity field
(`recordedByUserId`, `actorUserId`, `careActorId`, `tenantPicId`, `tenantId`)
is **rejected** with 400.

**200 response**

```json
{
  "success": true,
  "data": {
    "role": "BUILDING_CUSTOMER_CARE",
    "actor": { "userId": "…", "displayName": "…", "email": "…" },
    "grantedByPermission": "handyman.care.building",
    "scope": {
      "clientId": "…", "clientCode": "…", "propertyId": "…",
      "buildingId": "…", "buildingCode": "…", "buildingName": "…",
      "assignmentId": "…"
    },
    "capabilities": {
      "mayMediateBuildingCare": true,
      "mayRecordCareDecision": false,
      "mayApproveQuotation": false,
      "mayApproveVariation": false,
      "mayAcceptBast": false,
      "mayActAsTenantPic": false
    },
    "identitySource": "BACKEND_SESSION",
    "bmCareActorBinding": null,
    "decisionAuthority": {
      "status": "BLOCKED",
      "reason": "Authority B … remains disabled …",
      "endpoint": "/handyman/care-decisions",
      "method": "POST"
    }
  },
  "meta": { "grantedByPermission": "handyman.care.building", "authorityModel": "A" }
}
```

**Errors** (shared envelope; `error.category` is `FORBIDDEN` / `UNAUTHORIZED` /
`BAD_REQUEST` respectively)

| Status | Code | Meaning |
|---|---|---|
| 401 | `AUTHENTICATION_REQUIRED` | No/invalid session (includes non-ACTIVE accounts) |
| 403 | `PERMISSION_DENIED` | Actor lacks `handyman.care.building`. **Generic `tenant_company.manage` does not satisfy this.** |
| 403 | `HANDYMAN_CARE_AUTHORITY_DENIED` | Care actor, but not for this Building/Client. **Single code for all scope defects** — do not branch on sub-reasons, none are given. |
| 400 | `HANDYMAN_CARE_IDENTITY_NOT_ACCEPTED` | A recording identity was supplied. Derive it from the session; never send it. |
| 400 | `VALIDATION_ERROR` | Malformed `buildingId` / `clientId` |

### 7.2 Frontend rules

1. **Never send a recording identity.** `recordedByUserId` is server-derived.
2. **Never treat a 200 as Tenant approval.** A 200 is Authority A only.
3. **Render `capabilities` literally.** All commercial flags are `false`. Do
   not enable Approve / Accept / Variation buttons on the strength of Care
   authority.
4. **Render `decisionAuthority.status === 'BLOCKED'`** as a truthful disabled
   state. `POST /handyman/care-decisions` does not exist; calling it returns
   404. Do not build a call site for it yet.
5. **Scope is exact.** A Building granted under one Client confers nothing on a
   sibling Building, and nothing client-wide.
6. `bmCareActorBinding: null` means the BM Care identity is **not** in play. Do
   not render a BM Care persona from this payload.

---

## 8. Validation

Focused suite: `tests/handyman-care-building-authority.test.ts` — disposable
embedded PostgreSQL, 16 assertions groups, **all PASS**.

| Case | Result |
|---|---|
| Valid Building Care actor | PASS |
| Missing Care permission | PASS (403 `PERMISSION_DENIED`) |
| Wrong Building (same Client, no assignment) | PASS (403) |
| Wrong Client/Company asserted | PASS (403) |
| Correct Client/Company asserted | PASS (200) |
| INACTIVE (revoked) Building assignment | PASS (403) |
| Generic `tenant_company.manage` without Care authority | PASS (403) |
| Every non-Care capability as substitute | PASS (403) |
| Unauthenticated actor (no header / bad token) | PASS (401) |
| Authenticated but SUSPENDED account | PASS (401) |
| Spoofed recording identity (query + body, 4 field spellings) | PASS (400) |
| Cross-tenant Building access | PASS (403) |
| No quotation / variation / BAST mutation | PASS (row counts unchanged; POST/PUT/PATCH/DELETE → 404) |
| No Tenant/PIC identity in response | PASS |
| Permission registered + unassigned by default; 0449 unclaimed | PASS |
| Care Decisions transport disabled; table absent | PASS |

Also run: `npx tsc --noEmit` — **clean**.
No legacy suites and no production migrations were run.

---

## 9. Not Claimed

- Care Decision runtime — **not implemented**.
- BAST Sign-Off completion — **not complete**; SD-01…SD-15 remain Proposed.
- Tenant approval of Quotation / Variation / BAST — **not established**.
- BM Care session binding — **not connected**.
