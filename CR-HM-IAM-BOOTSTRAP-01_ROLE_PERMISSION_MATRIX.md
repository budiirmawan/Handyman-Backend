# CR-HM-IAM-BOOTSTRAP-01 — Role & Permission Matrix

Status: implementation complete, not deployed.
Authoritative source: `src/modules/iam-bootstrap/iam-canonical-roles.ts` and
`src/database/seeds/foundation-access.seed.ts`.

## 1. Rules this matrix obeys

1. **A role name grants nothing.** Authorization is resolved only through
   `user → user_role_assignments → roles → role_permission_assignments →
   permissions` (`permissionService.resolvePermissionsForUser`). Every route
   gate is an exact permission code.
2. **No invented privileges.** Every code below already exists in the
   authoritative `permissions` catalogue (foundation seed or an additive
   migration such as `handyman.care.building` from migration 0450). The
   bootstrap fails and rolls back if any referenced code is missing or not
   `ACTIVE`.
3. **Withheld authority stays withheld.** `PLATFORM_ADMIN` receives every
   foundation permission **except** `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`:
   financial execution (`handyman.finance.manage`,
   `handyman.settlement.manage`, `handyman.commercial.manage`), QC
   (`handyman.qc.manage`, `handyman.qc.configure`), BAST issuance
   (`handyman.bast.manage`), Building Care (`handyman.care.building`), budget
   override, RFQ award, price override, FX approval and the entire
   `platform.*` control plane. Those require an explicit, audited grant.
4. **Role assignment does not bypass tenant/Building isolation.** No
   `user_building_assignments`, Client, Property or Building row is created by
   the bootstrap. The existing BE-02G checks still require an ACTIVE
   assignment to the exact Building under the server-derived Client.
5. **Canonical roles are created once.** The first-owner bootstrap creates the
   five persona roles below transactionally. Subsequent role/permission
   administration goes through the authenticated API. The bootstrap cannot
   run again.

## 2. Owner

| | |
|---|---|
| Role code | `PLATFORM_ADMIN` (pre-existing foundation role) |
| Created by | Foundation seed, executed inside the bootstrap transaction |
| Purpose | Platform owner; manages identity, roles, permissions, audit and foundation configuration |
| Grant posture | All `FOUNDATION_PERMISSIONS` minus `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` |
| Explicitly **not** granted by bootstrap | `handyman.care.building`, `handyman.finance.read/manage`, `handyman.settlement.manage`, `handyman.commercial.manage`, `handyman.qc.manage/configure`, `handyman.bast.manage`, `operational_budget.override`, `rfq.award`, `price_catalog.override`, `fx_rate.approve`, every `platform.*` code |
| Identity | Exactly one account, created by the one-time CLI with an operator-chosen password (bcrypt cost 12) |

The Owner is the only canonical role that holds `user.manage`, `role.manage`
and `permission.manage` simultaneously. It can therefore:
create/suspend/reactivate users, invite users, reset passwords, assign/revoke
roles, define roles/permissions, read the authentication audit, and scope
users to Buildings.

## 3. Persona roles

### 3.1 SYSTEM_ADMIN — `SYSTEM_ADMIN`

**Purpose:** account administration and access verification without defining
authority.

| Permission | Why |
|---|---|
| `user.read`, `user.manage` | Inspect accounts, create/invite, activate/suspend, reset passwords |
| `role.read` | See which roles exist and which roles a user holds |
| `permission.read` | Verify effective permission lists |
| `auth.audit.read` | Read authentication/security events |
| `building.read`, `building.manage` | Assign/remove Building scope for accounts |
| `organization.read`, `workforce.read` | Resolve workforce identity within the accessible organization |

**Deliberately withheld:** `role.manage`, `permission.manage` (cannot mint a
role, attach a permission to a role, or assign `PLATFORM_ADMIN`),
`tenant_company.*`, all operational/financial/QC/BAST authority.

**Escalation guard:** a non-owner cannot reset the password of an account
holding `PLATFORM_ADMIN` (`403 PRIVILEGED_ACCOUNT_RESET_DENIED`). This closes
the account-takeover path that a plain `user.manage` grant would otherwise
create.

### 3.2 CUSTOMER_CARE — `CUSTOMER_CARE`

**Purpose:** tenant-facing mediation for explicitly assigned Buildings.

| Permission | Why |
|---|---|
| `tenant_company.read` | Building-scoped reads across the Handyman transport |
| `handyman.care.building` | Dedicated Authority-A capability (migration 0450); runtime still requires the exact ACTIVE Building assignment |
| `work_order.read`, `work_request.read` | See operational work affecting the tenant |
| `finding.read` | See complaints/defects raised for the Building |
| `document.read` | Read documents permitted to the account |
| `service_request.read`, `service_request.manage` | Handle tenant service requests |

**Deliberately withheld:** user/role/permission administration, dispatch
release, QC, BAST issuance, financial execution, `platform.*`, and — since
the security-hardening pass — the coarse `tenant_company.manage` code.

**Why `tenant_company.manage` was removed (hardening):** that single code
gates dispatch release/cancel, BAST customer accept/reject/sign-off,
customer-payment recording, lifecycle triage/diagnosis/referral, inspector
assignment and material purchasing. A tenant-facing care persona must not
inherit those operational/financial mutations through a shared gate. Removing
the grant is the smallest correction (no new, invented privilege) and keeps
tenant/Building isolation untouched: `handyman.care.building` plus the Care
resolver still require an ACTIVE assignment to the exact Building.

**Verified denial set:** `POST …/dispatch/release`, `POST …/dispatch/cancel`,
`POST /handyman/bast/{id}/accept`, `POST /handyman/bast/{id}/sign-off`,
`POST …/customer-payments`, `POST …/customer-payments/{id}/confirm`,
`POST /handyman/requests/{id}/triage` all return `403 PERMISSION_DENIED` for
`CUSTOMER_CARE` (focused test `CR-HM-IAM-BOOTSTRAP-01 — first-owner bootstrap`,
case 18).

### 3.3 OPERATIONS — `OPERATIONS`

**Purpose:** dispatch and day-to-day operational execution.

| Group | Permissions |
|---|---|
| Handyman transport gate | `tenant_company.read`, `tenant_company.manage` |
| Work | `work_order.read/manage`, `work_request.read/manage`, `engineering.read` |
| Findings | `finding.read/manage/assign/execute` (not `review`/`close`) |
| Scheduling | `schedule.read/manage`, `task.read/manage`, `checklist.read/manage` |
| Vendors/assets | `vendor.read/manage`, `asset.read/manage` |
| Inventory | `inventory_item.read/manage`, `inventory_stock.read/manage`, `material_request.read/manage` |
| Permits/documents/evidence | `permit.read/manage`, `document.read/manage`, `evidence.read/manage` |
| Utilities/workforce | `utility_meter.read/manage`, `workforce.read` |
| Safety | `safety_field_report.read` |
| Tenant service | `service_request.read` |

**Deliberately withheld:** `handyman.bast.manage`, `handyman.qc.*`,
`handyman.finance.*`, `handyman.settlement.manage`,
`operational_budget.override`, `rfq.award`, `price_catalog.override`,
`platform.*`, `user/role/permission.manage`.

### 3.4 MANAGER — `MANAGER`

**Purpose:** management oversight and governed approvals.

| Group | Permissions |
|---|---|
| Management reporting | `management_read_model.read`, `report_archive.read`, `reporting_export.read`, `report_export.generate`, `basic_financial_reporting.read` |
| Operational read | `work_order.read`, `work_request.read`, `finding.read`, `permit.read`, `document.read`, `vendor.read`, `asset.read`, `tenant_company.read`, `utility_meter.read`, `inventory_stock.read`, `service_charge_readiness.read`, `tenant_invoice.read`, `rfq.read`, `price_catalog.read`, `operational_budget.read`, `workforce.read`, `workforce_kpi.read`, `service_request.read`, `engineering.read` |
| Governed approval | `finding.review`, `finding.close`, `permit.approve`, `document.approve` |
| Financial oversight (read only) | `handyman.finance.read` |

**Deliberately withheld:** every operational mutation (`work_order.manage`,
`vendor.manage`, …), `handyman.finance.manage`,
`handyman.settlement.manage`, `operational_budget.override`, `rfq.award`,
`price_catalog.override`, `user/role/permission.manage`.

### 3.5 MOBILE_STAFF — `MOBILE_STAFF`

**Purpose:** field execution from the mobile browser/app.

| Group | Permissions |
|---|---|
| Handyman read gate | `tenant_company.read` |
| Attendance | `attendance.read/manage` |
| Execution | `form_instance.execute`, `task.read`, `checklist.read`, `work_order.read`, `evidence.read` |
| Field meters/materials | `utility_meter.field.read/record/evidence`, `material_request.field.read/request`, `material_usage.field.record` |
| Safety/security log | `safety_field_report.create/read`, `security_logbook.read/manage` |

**Deliberately withheld:** `tenant_company.manage`, dispatch release/cancel,
QC, BAST, finance/settlement, user/role/permission administration,
`platform.*`.

**Why this is sufficient:** the field execution services
(`/handyman/field/*`, work sessions, material execution) are
authentication-only or `tenant_company.read`-gated and resolve the CURRENT
Crew Lead / assignment / shift binding server-side. A permission grant cannot
substitute for that binding. Mobile mutations therefore need **no**
`tenant_company.manage`.

## 4. Per-user multi-persona model

One identity may hold several of the roles above simultaneously. Effective
permissions are the deduplicated union of all ACTIVE role grants. Example:

```
user: ani@example.com
roles: CUSTOMER_CARE + MANAGER
effective: care permissions + management read/approve permissions
scope: only Buildings with an ACTIVE user_building_assignment
```

Role assignments and Building scopes are independent:
* `POST /api/v1/users/{userId}/roles` assigns an existing role,
* `DELETE /api/v1/users/{userId}/roles/{roleId}` revokes it,
* `POST /api/v1/users/{userId}/buildings` scopes the user to a Building,
* `DELETE /api/v1/users/{userId}/buildings/{buildingId}` removes that scope.

The last ACTIVE `PLATFORM_ADMIN` assignment cannot be revoked
(`409 LAST_OWNER_ROLE_REQUIRED`). Assign a second Owner first.

## 5. Credential lifecycle guarantees

| Action | Endpoint | Sessions | Secret handling |
|---|---|---|---|
| Invite | `POST /invitations` → user accepts `POST /invitations/accept` | none until login | Invitee chooses their own password; raw invite token returned once |
| Admin reset | `POST /users/{id}/password-reset` | **all** revoked before the hash is written | bcrypt(12) only; `must_change_password=true`; no plaintext/hash returned |
| Self change | `POST /auth/password` | **all other** sessions revoked; caller kept | current password re-verified; bcrypt(12) only; `must_change_password=false` |
| Deactivate / suspend | `POST /users/{id}/deactivate|suspend` | all revoked | account state blocks login |
| Reactivate | `POST /users/{id}/reactivate` | none restored | old tokens remain revoked |

Plaintext passwords and hashes are never readable through any API. There is
no “show password” capability by design.

## 6. Audit events added by migration 0452

| Event | Emitted when |
|---|---|
| `OWNER_BOOTSTRAPPED` | The one-time bootstrap commits (same transaction) |
| `PASSWORD_RESET` | An administrator resets another account |
| `PASSWORD_CHANGED` | An authenticated user changes their own password |

Metadata contains ids/codes only — never passwords, hashes or tokens.

## 7. Authorization hardening (P0 security pass)

### 7.1 Protected (owner) accounts

A target account is **protected** while it holds an ACTIVE `PLATFORM_ADMIN`
assignment. Protected targets may only be modified by an actor that also holds
it — `user.manage` alone is never sufficient.

| Operation on a protected account | Non-owner administrator (e.g. `SYSTEM_ADMIN`) |
|---|---|
| `POST /users/{id}/suspend` | `403 PRIVILEGED_ACCOUNT_PROTECTED` |
| `POST /users/{id}/deactivate` | `403 PRIVILEGED_ACCOUNT_PROTECTED` |
| `PATCH /users/{id}/whatsapp-contact` | `403 PRIVILEGED_ACCOUNT_PROTECTED` |
| `POST /users/{id}/password-reset` | `403 PRIVILEGED_ACCOUNT_RESET_DENIED` |
| Assign/revoke `PLATFORM_ADMIN` or any role granting `role.manage` / `permission.manage` | `403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED` |

Additional invariants, enforced inside one transaction with an advisory lock:

- an administrator cannot suspend/deactivate **their own** account
  (`403 SELF_ACCOUNT_ACTION_DENIED`),
- the last **usable** owner account (ACTIVE assignment **and** ACTIVE account)
  cannot be deactivated or suspended (`409 LAST_OWNER_ACCOUNT_PROTECTED`),
- the last ACTIVE `PLATFORM_ADMIN` **role assignment** cannot be revoked
  (`409 LAST_OWNER_ROLE_REQUIRED`).

The lifecycle check runs under `pg_advisory_xact_lock(724196033)`; the
one-time bootstrap uses its own key `724196032`.

### 7.2 Privilege escalation through role assignment

Role assignment is authorization-checked **twice**: the route requires
`role.manage`, and the service re-checks that an actor assigning a privileged
role (owner role, or any role whose ACTIVE grants include `role.manage` or
`permission.manage`) is themselves an owner. A delegated administrator
therefore holds `role.manage` without being able to mint an owner.

### 7.3 Mandatory password change

`user_credentials.must_change_password` is enforced in the authentication
middleware on **every** request (no second session mechanism, no cached flag).
While true, only these are reachable:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/password` | Set the new password (current password re-verified) |
| `GET` | `/auth/password/status` | Read `{ mustChangePassword }` |
| `POST` | `/auth/logout` | End the session |
| `GET` | `/auth/me` | Read-only identity/effective context |

Everything else returns `403 PASSWORD_CHANGE_REQUIRED`. Session invalidation
is unchanged: admin reset revokes **all** sessions before writing the hash;
self change revokes **all other** sessions and keeps the caller's.

### 7.4 Error codes added by the hardening pass

| Code | Status | Meaning |
|---|---|---|
| `PRIVILEGED_ACCOUNT_PROTECTED` | 403 | Non-owner attempted a lifecycle/contact change on an owner account |
| `PRIVILEGED_ACCOUNT_RESET_DENIED` | 403 | Non-owner attempted a credential reset on an owner account |
| `PRIVILEGED_ROLE_ASSIGNMENT_DENIED` | 403 | Non-owner attempted to assign/revoke an authority-defining role |
| `SELF_ACCOUNT_ACTION_DENIED` | 403 | Administrator attempted a lifecycle transition on their own account |
| `LAST_OWNER_ACCOUNT_PROTECTED` | 409 | Attempted to deactivate/suspend the last usable owner account |
| `PASSWORD_CHANGE_REQUIRED` | 403 | Forced password change still pending |

See `CR-HM-IAM-BOOTSTRAP-01_MULTI_PERSONA_CONTRACT.md` for how these map to
the Owner's multi-application access.
