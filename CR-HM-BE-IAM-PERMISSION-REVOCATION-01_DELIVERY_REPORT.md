# CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — Delivery Report & Operations Handoff

**Scope:** Handyman-Backend only. No merge, no deployment, no change to the
Biznet PostgreSQL. All verification ran against a disposable embedded
PostgreSQL 18.4 (`127.0.0.1:55583` / suite-local clusters) that was removed
after the run.
**Branch:** `arena/37aa07d3-handyman-backend` (from `main` @ `e8b94af`).
**Objective:** close dependency **D-01/G-03** of Handyman-Operations PR #30 —
permission-grant revocation enforced by backend authority.

---

## 1. Pre-flight audit (mandatory)

| Check | Result |
| --- | --- |
| Active branch | `arena/37aa07d3-handyman-backend`, clean at `e8b94af` (merge of PR #54) |
| `main` up to date | `origin/HEAD → origin/main` at `e8b94af`; no divergence |
| Existing IAM/RBAC surface | `POST /api/v1/roles/:roleId/permissions` (assign) and `GET /api/v1/roles/:roleId/permissions` (list) exist since BE-01E/PR #41; **no revoke endpoint existed anywhere** (`src/`, `tests/`, `docs/` grepped) |
| Revoke endpoint already available? | **No** — implemented in this CR |
| Pending PRs | **#55** CR-HM-WORKER-COMPETENCY-01 (open, branch `arena/3df97f5e-handyman-backend`), **#47** CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 (open) |
| PR #41 compatibility | Reused its exact conventions: soft-revoke assignment model, `pg_advisory_xact_lock` mutation serialization, owner-only privileged guard (`privileged-account.guard`), `LAST_*` invariant errors, `recordEvent` audit model, `ROLE_ASSIGNED/ROLE_REVOKED` audit vocabulary pattern |
| PR #55 compatibility | See §4 — no file collision; migration numbers deliberately chosen outside PR #55's `0461–0467` range |
| Reset / overwrite / cherry-pick | None performed |

## 2. Implementation

### 2.1 Endpoint (new)

```
DELETE /api/v1/roles/:roleId/permissions/:permissionId
```

- **Gate:** `authenticationMiddleware` + `requirePermission('permission.manage')`
  (the existing backend-authority gate for permission management).
- **Success:** `200` with the shared success envelope
  (`{ success: true, data: PublicPermission, meta: {} }`) — same shape as
  `revokeRoleFromUser`. Only the **grant** is removed: the permission catalogue
  entry and the role are never deleted or mutated.
- **Assignment model (existing):** `role_permission_assignments` soft revoke
  (`ACTIVE → REVOKED`), history retained, partial unique index unchanged.

### 2.2 Protection policy (backend authority)

| Rule | Behavior | Canonical error |
| --- | --- | --- |
| Privileged target (the `PLATFORM_ADMIN` role, any role currently granting an authority-defining permission, or revoking an authority-defining permission itself: `role.manage`, `permission.manage`, `user.manage`, `building.manage`) | Owner-only — actor must hold ACTIVE `PLATFORM_ADMIN` | `403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED` (reused canonical code, same message contract as role-assignment guard) |
| Last administrative capability | The **last ACTIVE grant of an authority-defining permission** cannot be revoked; grant it to another role first. Structurally identical to `LAST_OWNER_ROLE_REQUIRED` at the role layer; prevents permanent loss of any administration capability (incl. the unrecoverable `permission.manage` lockout) | `409 LAST_ADMIN_PERMISSION_REQUIRED` (new canonical code, additive) |
| Unknown role / permission / grant | Distinct, non-disclosing codes | `404 ROLE_NOT_FOUND`, `404 PERMISSION_NOT_FOUND`, `404 ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND` |
| Repeated revocation | Idempotent-by-state: the grant is no longer ACTIVE → `404 ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND`; exactly one `SUCCESS` audit event ever exists per grant; no state churn | as above |
| Malformed UUIDs | `400 VALIDATION_ERROR` with field details | `VALIDATION_ERROR` |

Concurrency: grant mutations run in one transaction behind
`pg_advisory_xact_lock(724196035)` (distinct from `ROLE_MUTATION_LOCK`
724196034 / account-lifecycle 724196033 / bootstrap 724196032 / migrations
724196031), so concurrent revocations cannot both observe "another grant
remains" and strip the last one.

### 2.3 Effective permissions & existing sessions

RBAC (`requirePermission`) and `GET /api/v1/auth/me` re-resolve effective
permissions from the assignment tables **on every request** (BE-01E resolver,
single source of truth). Therefore:

- an existing ("stale") session token stays **authenticated** (sessions are
  never destroyed by a grant revocation) but immediately loses the revoked
  capability — enforced surfaces return `403 PERMISSION_DENIED` and
  `/auth/me → access.permissions` reflects the removal on the same token;
- partial revocations leave the remaining permissions of the same role intact;
- authentication, tenant/Building isolation machinery and **all user
  credentials/passwords are untouched** (the endpoint writes only
  `role_permission_assignments.status/updated_at`).

### 2.4 Audit trail (existing audit-logging model)

Migration `0468_extend_permission_grant_audit_events` (additive, follows the
0453/0454/0457 pattern) extends the `authentication_audit_events` vocabulary:

- `PERMISSION_GRANTED` — recorded by `POST /roles/:roleId/permissions`;
- `PERMISSION_REVOKED` — recorded by the new revoke endpoint.

Both carry `actorUserId`, `requestId`, `ipAddress`, `userAgent` and metadata
`{ roleId, roleCode, permissionId, permissionCode }` (non-secret, subject to
the existing metadata sanitizer). Visible via
`GET /api/v1/auth/audit-events?eventType=PERMISSION_REVOKED` for holders of
`auth.audit.read`. Up/Down both verified on the disposable database (down
restores the previous CHECK and rejects the new types; up re-applies cleanly).

### 2.5 Files changed

| File | Change |
| --- | --- |
| `src/modules/permissions/permission.{routes,controller,service,repository,errors,index}.ts` | revoke endpoint, guards, audit, soft-revoke + count repository methods, new 409 error factory |
| `src/modules/audit/audit.types.ts` | `PERMISSION_GRANTED` / `PERMISSION_REVOKED` event types |
| `src/shared/errors.ts` | `LAST_ADMIN_PERMISSION_REQUIRED` (additive) |
| `src/database/migrations/0468_extend_permission_grant_audit_events.ts` + `index.ts` | audit CHECK extension (up/down) |
| `docs/api/openapi.yaml` | `DELETE /roles/{roleId}/permissions/{permissionId}` (operationId `revokePermissionFromRole`, `x-required-permission`, `x-error-codes`) |
| `tests/permission-revocation.test.ts` | focused suite (8 cases) |

**Not changed:** default roles, permission catalogue contents, seeds, global
permission grants, user/credential/session tables, Building isolation, auth
flows.

## 3. Verification (focused; full suite intentionally not run)

Disposable PostgreSQL 18.4 via the repository `embedded-postgres` harness;
temporary clusters removed after the run. No Railway/Biznet connection used.

| Gate | Result |
| --- | --- |
| `tests/permission-revocation.test.ts` (new) | **8/8 pass** — successful revocation (delegated `permission.manage` holder), repeated revoke, unauthenticated/under-privileged (401/403), protected system role + authority-defining grant (owner-only), last-admin-capability (409) + recovery via second grant, stale-session effective-permission refresh + password preservation, audit trail (grant+revoke, actor, metadata, audit read API), id/unknown/grant validation |
| Focused IAM/OpenAPI batch (final run) | **143 tests / 30 suites, 143 pass, 0 fail, 0 skipped** — `permission-revocation`, `permissions`, `roles`, `iam-bootstrap`, `audit`, `sessions`, `openapi-contract`, `error-contract`, `mobile-openapi-completeness`, `config-perm-01-permission-registry` |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| Migration 0468 up/down | pass (constraint restored on down; new types rejected after down; clean re-apply) |
| OpenAPI parity `openapi-saas-route-parity` | 14/15 — the single failure is **pre-existing on the base commit** (verified with a stashed tree): 3 broken property-level `$ref`s into `HandymanStatusVisibilityReadView` (`docs/api/openapi.yaml` lines ~6990–6994: `stages/properties/assignment`, `stages/properties/readiness`, `slaMilestones`). Unrelated to this CR's surface; deliberately **not** fixed here to avoid colliding with PR #55's openapi.yaml edits — tracked as known debt |

## 4. Dependency report

### 4.1 Closes Handyman-Operations PR #30 (D-01/G-03)

Backend now provides the authority the Operations UI needs to **revoke a
permission grant from a role**: `DELETE /api/v1/roles/:roleId/permissions/:permissionId`
with `permission.manage`. Operations integration notes in §5.

### 4.2 Compatibility with PR #55 (CR-HM-WORKER-COMPETENCY-01) and PR #41

- **Migration numbering:** PR #55 occupies `0461–0467`. This CR takes
  **`0468`** deliberately — zero id/file collision in either merge order.
  Note: if both PRs merge, `src/database/migrations/index.ts` will need a
  trivial *additive* conflict resolution at the tail import/list (both append
  after `0460`); no semantic conflict exists.
- **`src/shared/errors.ts`:** this CR adds one code inside the IAM permission
  block; PR #55 adds workforce-certification codes elsewhere — independent
  hunks.
- **`docs/api/openapi.yaml`:** this CR adds a path item under Roles &
  Permissions; PR #55 adds service-competency/work-order content elsewhere —
  independent hunks. Re-run `openapi-contract` + parity suites after either
  merge.
- **Runtime:** no shared modules mutated beyond the permission module's
  additive surface; PR #55's `0462_workforce_certification_permissions`
  permission-code registrations flow through `permissions` + role grants
  unchanged and remain revocable under the same policy (non-authority codes
  are revocable by any `permission.manage` holder).
- **PR #41 (merged):** its patterns are reused, not duplicated; no changes to
  its role/user/invitation/session flows. Focused IAM suites from PR #41
  (`iam-bootstrap`, `roles`, `permissions`, `sessions`, `audit`) all pass.
- **PR #47 (open):** its file `0459_handyman_bank_receipt_attestation.ts`
  collides in number with main's `0459_handyman_request_cancellation.ts` —
  pre-existing debt for that PR's author; unaffected by this CR.

### 4.3 Audited and recorded as separate work (not in this CR)

- **D-04 — step-up authentication:** not implemented anywhere in the backend
  (no re-auth/second-factor seam exists in `src/modules/auth`). The revocation
  endpoint relies on the standard session + RBAC + owner guards. A future
  step-up CR should add a re-verification seam (password/second factor) for
  authority mutations and can attach it to this endpoint without contract
  change.
- **D-05 — invitation email:** `email-delivery` (SMTP adapter) exists but
  invitation email delivery is **not wired** (`invitation.service` reports
  `delivery.available: false` with an explicit "no email was sent" note and
  returns the one-time token for controlled out-of-band handoff). Wiring real
  SMTP delivery is a separate CR; invitation lifecycle/security posture is
  unchanged by this work.

## 5. Operations handoff (Handyman-Operations PR #30, D-01/G-03)

### 5.1 Contract

```
DELETE /api/v1/roles/:roleId/permissions/:permissionId
Authorization: Bearer <sessionToken>   // actor needs permission.manage
```

Success `200`:

```json
{ "success": true, "data": { "id": "…", "code": "…", "name": "…",
  "description": null, "status": "ACTIVE" }, "meta": {} }
```

(`data` is the **permission catalogue entry** of the revoked grant — the entry
survives; only the role↔permission grant is removed.)

Error envelope (shared canonical shape):

| HTTP | `error.code` | When | UI guidance |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | malformed roleId/permissionId | fix input |
| 401 | `AUTHENTICATION_REQUIRED` | missing/invalid session | re-login |
| 403 | `PERMISSION_DENIED` | actor lacks `permission.manage` | no retry |
| 403 | `PRIVILEGED_ROLE_ASSIGNMENT_DENIED` | target is a system/privileged role or the grant is authority-defining and the actor is not an Owner (`PLATFORM_ADMIN`) | route to Owner; do not retry |
| 404 | `ROLE_NOT_FOUND` / `PERMISSION_NOT_FOUND` | unknown ids | refresh list |
| 404 | `ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND` | grant absent or **already revoked** (repeat-safe) | treat as already-revoked; refresh list |
| 409 | `LAST_ADMIN_PERMISSION_REQUIRED` | would remove the last ACTIVE grant of `role.manage` / `permission.manage` / `user.manage` / `building.manage` | show "grant to another role first"; suggest the assign endpoint |

### 5.2 Behavioral guarantees for the UI

- **Idempotent-safe:** a repeated DELETE returns `404 ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND`
  and changes nothing — implement "revoke" buttons as one-shot and map that
  404 to "already revoked" if re-listed state disagrees.
- **Effective permissions refresh immediately**, including for users with live
  sessions: re-fetch `GET /api/v1/auth/me` (or your permission store) after a
  revocation; no logout is required and none is performed.
- **Assign counterpart:** `POST /api/v1/roles/:roleId/permissions` with body
  `{ "permissionId": "…" }` (unchanged) — used to create the replacement
  grant before a last-grant revocation.
- **Audit:** every grant/revocation is queryable via
  `GET /api/v1/auth/audit-events?eventType=PERMISSION_REVOKED` (needs
  `auth.audit.read`); metadata carries `roleId`, `roleCode`, `permissionId`,
  `permissionCode`.
- **OpenAPI:** `docs/api/openapi.yaml` → `/roles/{roleId}/permissions/{permissionId}`
  (operationId `revokePermissionFromRole`) is authoritative for codegen.

### 5.3 Non-goals restated

No merge, no deploy, no PostgreSQL Biznet change, no default-role change, no
global permission grant, no password/credential mutation, no change to tenant
isolation. Full-suite tests were intentionally not run (PART 01 instruction).
