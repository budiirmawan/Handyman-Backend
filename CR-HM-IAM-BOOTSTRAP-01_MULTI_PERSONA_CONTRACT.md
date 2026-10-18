# CR-HM-IAM-BOOTSTRAP-01 — Owner Multi-Persona Contract

**Audience:** frontend/mobile integration teams and the operator who assigns
roles. This document is the authoritative description of how one identity
accesses multiple applications, and where platform administration ends.

Status: implemented in the backend (`GET /auth/me`, `GET /auth/password/status`,
role assignment/revocation, privileged-account guards). No unrestricted
superuser is created.

---

## 1. Principles

1. **One identity, many roles.** A user row is the only identity. Applications
   do not get separate accounts, separate tokens or separate sessions.
2. **A role name grants nothing.** Every authorization decision resolves
   permissions `user → user_role_assignments (ACTIVE) → roles (ACTIVE) →
   role_permission_assignments (ACTIVE) → permissions (ACTIVE)`. The union of
   the grants is the effective permission set.
3. **Capability is not data.** Holding a permission makes an action
   *possible*; the existing tenant/Building isolation still decides *which*
   Client, Property and Building are reachable. No role and no bootstrap step
   creates a Building assignment.
4. **Platform administration ≠ operational execution.** The Owner administers
   identities and authority. Sensitive operational/financial approvals keep
   their own dedicated authority and are deliberately withheld from
   `PLATFORM_ADMIN`.
5. **No silent bypass.** Nothing in this contract lets an Owner skip an
   approval step, a QC gate, a BAST assertion or a financial verification.
   Those are separate permission codes, and the services that own the state
   machine enforce them.

## 2. Login and session contract

| Concern | Contract |
|---|---|
| Login | `POST /auth/login` `{ email, password }` → `{ sessionToken, expiresAt, user }`. One opaque token, hashed at rest, no refresh endpoint |
| Effective identity | `GET /auth/me` → `{ user, access: { roles, permissions }, context, scope, entitlements }` |
| Forced password change | `GET /auth/password/status` → `{ mustChangePassword }` (checked after login and on any `403 PASSWORD_CHANGE_REQUIRED`) |
| Change password | `POST /auth/password` `{ currentPassword, newPassword }`; keeps the caller's session, revokes all others |
| Logout | `POST /auth/logout`; idempotent revocation of the current session |

There is **no per-application login**. A user assigned `CUSTOMER_CARE` and
`MANAGER` logs in once; the console and the mobile app both call `/auth/me` and
render from the same effective context.

`/auth/me` is deliberately frozen: `mustChangePassword` is **not** a field
there. Clients must read it from `GET /auth/password/status`.

## 3. Application access map

| Application / surface | Gate | Typical roles |
|---|---|---|
| Web admin console — identity, roles, Building scope | `user.*`, `role.*`, `permission.*` | `PLATFORM_ADMIN` (full), `SYSTEM_ADMIN` (accounts + scope, no role/permission definition) |
| Operations console — work orders, scheduling, vendors, inventory | `work_order.*`, `schedule.*`, `vendor.*`, `asset.*`, `inventory_*` | `OPERATIONS` |
| Management reporting / approvals | `management_read_model.read`, `report_*`, `finding.review/close`, `permit.approve` | `MANAGER` |
| Tenant / Customer Care workspace | `handyman.care.building` + ACTIVE Building assignment, `service_request.*`, read-only Handyman transport | `CUSTOMER_CARE` |
| Mobile browser / app — field execution | authentication + server-side Crew Lead / assignment / shift binding; `tenant_company.read` baseline | `MOBILE_STAFF` (plus any role the person already holds) |

An Owner who also performs operational work receives the operational role
**explicitly** (for example `OPERATIONS`). The Owner role is not a substitute
for it, and assigning it is an audited action.

## 4. Role assignment contract

| Operation | Endpoint | Rule |
|---|---|---|
| Assign | `POST /users/{userId}/roles` `{ roleId }` | requires `role.manage`; privileged roles additionally require the actor to be an owner |
| Revoke | `DELETE /users/{userId}/roles/{roleId}` | requires `role.manage`; 404 if not assigned; 409 if it is the last owner role |
| List | `GET /users/{userId}/roles` | `role.read` |
| Scope | `POST /users/{userId}/buildings` / `DELETE …/{buildingId}` | `building.manage`; scope is independent of roles |

A person who needs two applications gets **two roles on one identity**, not a
second account. Removing one role leaves the other intact; removing the last
one leaves the identity authenticated but with an empty permission set (every
protected route answers `403`).

## 5. Owner entitlements and separation of duties

`PLATFORM_ADMIN` receives every foundation permission **except** the
withholding set. The following stay unassigned until an explicit, audited
grant is made (and even then they remain separate codes, not implied by the
role name):

- `handyman.finance.manage`, `handyman.settlement.manage`,
  `handyman.finance.read` (Owner has read via foundation grants where defined),
- `handyman.qc.manage`, `handyman.qc.configure`,
- `handyman.bast.manage`, `handyman.care.building`,
- `operational_budget.override`, `rfq.award`, `price_catalog.override`,
  `fx_rate.approve`,
- every `platform.*` control-plane code.

Consequences for the product:

- the Owner **cannot** verify or settle money merely by being the Owner,
- the Owner **cannot** issue or sign off BAST, or record QC results,
- the Owner **cannot** act as a Building Customer Care actor,
- an Owner who needs one of those capabilities receives an explicit
  operational role (e.g. `MANAGER` for governed approvals) or an explicit
  permission grant, both visible in `/auth/me` and in the audit trail.

Customer-side actions that are intentionally reachable by tenant personas
(recording a customer payment, accepting BAST as the customer) are **not**
granted to `CUSTOMER_CARE` either: they sit behind the coarse
`tenant_company.manage` gate, which the care persona no longer holds.

## 6. Forced password change in the client

1. After login, call `GET /auth/password/status`.
2. If `mustChangePassword` is `true`, route to the change-password screen and
   do not issue other requests. Any request that slips through returns
   `403 PASSWORD_CHANGE_REQUIRED` — treat it as "navigate to change password",
   not as an authorization failure and never as a logout.
3. `POST /auth/password` with the temporary (current) password and the new one.
   The current session stays valid; every other session is revoked.
4. Re-read `/auth/password/status` (`false`) and resume normally.
5. `POST /auth/logout` is always available, including in the forced state.

## 7. Error handling for the frontend

| Status | Code | UI behavior |
|---|---|---|
| 403 | `PASSWORD_CHANGE_REQUIRED` | Navigate to forced change; do not clear the token |
| 403 | `PRIVILEGED_ACCOUNT_PROTECTED` | "Only an owner can modify this account" |
| 403 | `PRIVILEGED_ACCOUNT_RESET_DENIED` | Same, for password reset |
| 403 | `PRIVILEGED_ROLE_ASSIGNMENT_DENIED` | "Only an owner can assign this role" |
| 403 | `SELF_ACCOUNT_ACTION_DENIED` | Disable self-suspend/deactivate controls |
| 409 | `LAST_OWNER_ACCOUNT_PROTECTED` | "Assign a second owner first" (lifecycle) |
| 409 | `LAST_OWNER_ROLE_REQUIRED` | "Assign a second owner first" (role revocation) |
| 404 | `ROLE_ASSIGNMENT_NOT_FOUND` | Refresh the role list |

## 8. What this contract deliberately does not do

- No unrestricted superuser: `PLATFORM_ADMIN` is bounded by the withholding
  set and by the tenant/Building resolvers.
- No impersonation: the actor is always `req.auth.userId`; no request field
  can name another actor for authority purposes.
- No second token type, no refresh token, no service token for the console.
- No MFA, no second Owner, and no automated token delivery yet — these remain
  release blockers tracked in the delivery report.
