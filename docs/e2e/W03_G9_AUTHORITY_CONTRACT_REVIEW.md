# W03 G9 — Authority Contract Freeze & Implementation Readiness

| Field | Value |
|---|---|
| Authority status | **OWNER APPROVED — architectural decisions frozen** |
| Implementation readiness | **BLOCKED** — initial RBAC grant path and secure Operations secret delivery are not established in this repository; see §8. |
| Owner approval recorded | 2026-10-11: existing authenticated Operations identity; dedicated explicit RBAC permission; integration-wide BM/PIC attestation; Operations-controlled secret injection. |
| Permission identifier | `integration.capability.provision` — carried forward from the prior G9 proposal as the dedicated permission name. It is not yet registered or granted. |
| Baseline verified before edits | Local HEAD and `origin/arena/b4a8612c-handyman-backend` both `2f7103dcb41cef8f981bc588564c31ba4ed4ec6c`; clean worktree. |
| Branch | `arena/b4a8612c-handyman-backend` |
| Scope | Documentation only. No production code, migration, test, typecheck, deployment, or authority grant. |

## 1. Owner-approved architectural freeze

The following are now **OWNER APPROVED**, not merely proposed. Approval freezes the authority design; it does not establish that the mechanisms are already implemented or operationally provisioned.

1. **Identity:** use an existing authenticated Operations identity. Do not create a new authentication system or service identity for G9.
2. **Authorization:** require the dedicated explicit permission `integration.capability.provision`. It is an exceptional authority and must not be automatically granted. It gates the integration capability lifecycle, including the operational downgrade to `NONE` needed for revocation/rollback; no second G9 permission is introduced by this contract.
3. **Attestation scope:** `TENANT_PIC` is integration-wide for the BM/PIC channel, not per company. Company/building/business authority remains downstream in PIC context resolution and existing binding/decision checks.
4. **Secret boundary:** Operations controls secret injection into the Handyman runtime environment. Plaintext secret material must never be persisted in the database or emitted in CLI/API output, logs, audit metadata, or shell arguments/history.
5. **Provisioning surface and roles:** no G9 HTTP provisioning endpoint; no Handyman Platform Admin dependency; do not create a new Operations role unless an existing suitable role is proven absent and a separate role change is strictly necessary and authorized.
6. **Non-effects:** no automatic RBAC grants, PIC bindings, or quotation approvals. B12 remains OFF. S1 staff decision remains 403.
7. **Migration posture:** preserve migration 0441's forward-fix-only behavior after it has recorded PIC-session history; do not use migration rollback as operational revocation.

**Freeze boundary:** the decisions above are frozen. The concrete initial permission grantor, non-HTTP credential ingress, secret provider/deployment workflow, and audit null-client classification below are **not** verified by the approval statement or by this checkout. They are not to be invented as implementation details.

## 2. Verified existing application primitives

- `sessionService.resolveSessionContext(rawToken)` hashes and resolves the existing local bearer session, checks session status/expiry, and revalidates the user's login-eligible state (`src/modules/auth/session.service.ts:49-85`).
- `permissionService.resolvePermissionsForUser(userId)` resolves active role/permission assignments; `requirePermission(code)` is the existing HTTP default-deny gate (`src/modules/permissions/permission.service.ts:113-126`; `src/modules/auth/rbac.middleware.ts:14-47`). These are usable primitives, not a G9 caller.
- `setIntegrationActorCapability()` currently accepts only `{ integrationId, capability }`; it does not authenticate an operator, authorize a permission, or write an audit event (`src/modules/handyman-care-actors/handyman-care-actor.service.ts:89-108`).
- W03 03C specifies one integration row for the BM PIC channel (`docs/e2e/W03_PART03C_PIC_SESSION_SECURE_HANDOFF.md:117-120`). The integration schema has no `client_id` or `tenant_company_id` (`src/database/migrations/0375_create_handyman_handoff_runtime.ts:24-38`).
- PIC admission requires an ACTIVE integration with `TENANT_PIC`; subsequent session authority checks the integration, tenant, PIC membership, and represented context. The quotation binding separately validates the tenant/PIC lineage and business basis (`src/modules/handyman-pic-session/pic-workspace-session.repository.ts:49-64,96-133`; `src/modules/handyman-quotation-approval-bindings/handyman-quotation-approval-binding.service.ts:313-404`).
- `withTransaction()` exists. Operational events are append-only and accept a caller executor. The capability repository setter accepts an optional `PoolClient`, but the exported service does not expose it and `handoffRuntimeRepository.createIntegration()` does not accept one (`src/database/transaction.ts:8-23`; `src/modules/handyman-care-actors/handyman-care-actor.repository.ts:129-143`; `src/modules/handyman-handoff/handoff-runtime.repository.ts:28-40`).
- Migration 0441 invalidates all live PIC workspace sessions when an integration loses `TENANT_PIC`; PIC-session history cannot be deleted or restored by re-enabling the capability. Its `down` refuses when any session history exists or an integration still holds the capability (`src/database/migrations/0441_handyman_pic_workspace_sessions.ts:130-167,171-195`).

## 3. Frozen bootstrap authentication, authorization, and scope

### Authentication and authorization contract

A future **non-HTTP Operations command** must act for an existing authenticated local user:

1. Resolve the operator from an existing session using `sessionService.resolveSessionContext`; derive `actorUserId` only from that authenticated context. A caller-supplied user ID is not proof of identity.
2. Resolve current effective permissions and require exactly `integration.capability.provision`. Missing, inactive, expired, or unauthorized identity fails closed before mutation.
3. Use the same dedicated permission for the controlled capability transition to `TENANT_PIC` and its rollback transition to `NONE`. This permission grants no PIC binding, quotation-decision, tenant-management, or role-assignment authority.
4. No new HTTP endpoint, Platform Admin check, local bypass, or automatic grant is allowed.

**Not an existing implementation:** the repository has no G9 command and no approved secure way for a non-HTTP process to receive an existing session context. Existing local-session resolution is verified; a CLI credential-ingress adapter is not. Do not put a bearer token in argv, shell history, logs, or an unprotected environment variable. The invocation must use an already-approved Operations credential channel; until that channel is identified, no implementation is ready.

### Integration-wide scope contract

- The integration-level capability is BM/PIC-channel-wide. The provisioning command carries no tenant-company or building scope, and no per-company integration row is created.
- A signed representation still resolves to Handyman-owned tenant/PIC/building/space authority at admission and use. Quotation binding remains a separate, explicit business-authority action over its own tenant/building/request lineage.
- G9 cannot create or alter a PIC binding, approve a quotation, or grant an application-user permission. The owner-approved integration-wide decision supersedes the earlier direct per-company integration-scope concern; no company-scope schema change is required by this contract.
- For first activation, the integration record must not become PIC-capable before the secret is available to the runtime. The current schema defaults the actor capability to `NONE` (`src/database/migrations/0425_add_handyman_care_actor_registry.ts:32`); future implementation must create/resolve the integration, transition it to `TENANT_PIC`, and record the audit in one transaction. The current create/service seams do not yet provide that atomic path (§7).

## 4. Initial RBAC grant path — verified mechanism, **not authorized end-to-end**

### Existing generic mechanism

The application has role-based, not direct user-permission, authorization; effective permissions resolve through user → active roles → active role-permission assignments (`src/modules/permissions/permission.service.ts:113-125`). The verified generic administration paths are:

| Operation | Existing route path | Required permission |
|---|---|---|
| Register a permission at runtime | `POST /permissions` | `permission.manage` |
| Assign a permission to an existing role | `POST /roles/:roleId/permissions` | `permission.manage` |
| Create a role | `POST /roles` | `role.manage` |
| Assign an existing role to a user | `POST /users/:userId/roles` | `role.manage` |

Route evidence: `src/modules/permissions/permission.routes.ts:14-47` and `src/modules/roles/role.routes.ts:18-45`. These are general RBAC administration routes, not a G9 provisioning endpoint. The source-controlled permission-catalogue path is `FOUNDATION_PERMISSIONS` plus `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`; the new code must be registered and deliberately excluded from default grants. The seed grants default, non-exceptional permissions to its seeded role.

### Why the exact authorized Operations grant path is **not verified**

- The foundation seed explicitly says it is the only RBAC bootstrap data, seeds only `PLATFORM_ADMIN`, and seeds no user, credential, or password (`src/database/seeds/foundation-access.seed.ts:5-13,836-890`). `permission.manage` and `role.manage` are in the catalogue and are not in the unassigned-by-default set, so the seeded `PLATFORM_ADMIN` role receives them by default.
- No Operations role or Operations user-role assignment is created by the seed. Existing exceptional Operations permissions such as `handyman.operations.request.read` and `.triage` are intentionally unassigned by default.
- The Operations production-role grant is already documented as open: W02 says the role is not defined in this repository and no grant is made by code (`docs/e2e/W02_OPERATIONS_QUEUE_HANDOFF.md:23-35,124`; `docs/e2e/W02_VERIFICATION_DEBT.md:69-75,358`).
- Therefore, the **technical route sequence** exists, but the **authorized non-Platform-Admin grantor and target Operations role/user are not established**. Using the only seeded role's `permission.manage`/`role.manage` authority would violate the owner-approved no-Platform-Admin dependency. A deployment may have additional role/user grants, but no evidence for them is available in this checkout.

**Grant contract:** register `integration.capability.provision` as a dedicated, unassigned-by-default permission, then assign it only to an already-approved Operations role through an authorized Operations grant path. Do not auto-grant it to `PLATFORM_ADMIN`, another tenant-facing role, or every Operations user. Do not create a new Operations role unless the existing deployed role inventory proves none is suitable; if none exists, that role and its non-Platform-Admin grant path require explicit authorization before implementation.

**RBAC readiness: BLOCKED.** Missing evidence is the approved existing Operations role code/assignment and an authorized non-Platform-Admin principal or already-approved Operations provisioning mechanism able to register/assign the permission. The generic routes alone do not satisfy this requirement.

## 5. Operations secret injection — reader verified, delivery path **not established**

### Verified runtime boundary

- The only code-level contract is `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>`: uppercase the integration code and replace non-alphanumeric characters with `_` (`src/modules/handyman-handoff/handoff-runtime.config.ts:20-25`). `readHandoffIntegrationSecret()` reads that name from `process.env` and returns `null` if absent (`src/modules/handyman-handoff/handoff-runtime.config.ts:59-66`).
- The integration table stores trust metadata only; it has no secret column (`src/database/migrations/0375_create_handyman_handoff_runtime.ts:5-17,24-38`).
- Repository searches found no handoff-secret reference or secret-manager integration in `Dockerfile`/`docker-compose.yml`, no tracked deployment/CI secret-provider configuration, and no Operations delivery runbook. Tests setting `process.env` are fixtures, not a production secret-delivery mechanism.

### Owner-approved boundary vs missing mechanism

**OWNER APPROVED:** Operations, not Handyman Platform Admin or an HTTP endpoint, controls injection of the per-integration secret into the application runtime.

**NOT VERIFIED:** this checkout identifies no secret manager/provider, Operations access policy, deploy/injection command, target runtime configuration, propagation/rotation/revocation workflow, or audit evidence. Reading an environment variable is not evidence that Operations can securely install it. The exact secure delivery path cannot be named from the available artifacts.

**Secret readiness: BLOCKED.** Before implementation, evidence must identify the already-approved Operations-controlled mechanism and show how it injects the named variable into every runtime that verifies PIC assertions (and any bootstrap process that performs a presence check), how access and changes are audited, and how rotation/removal is performed. Do not substitute `.env`, Docker Compose literals, shell arguments, database storage, or a newly invented secret-manager integration. Never display or log a secret value.

## 6. Audit contract and remaining audit-scope decision

### Required implementation audit behavior (design contract; no G9 event is implemented)

- Record every effective capability transition append-only with the authenticated `actorUserId`, integration ID/code, previous and new capability, and operation correlation ID.
- Never record the secret, signature, bearer token, raw environment value, or other credential material. The Handyman event and the Operations secret-system audit are distinct records; correlate them only with nonsecret integration/operation identifiers.
- Capability state and its Handyman audit event must commit or roll back together. An audit insert failure must not leave an unaudited grant. The current repository/service seams need transaction plumbing before a single atomic create/grant/audit flow is possible.

These are the reviewed G9 implementation requirements, not evidence of an existing G9 audit event or an additional owner approval of its taxonomy.

### Proposed event shape — event taxonomy/scope not yet verified

Use `recordOperationalEvent()` with `entityType = HANDOFF_INTEGRATION`, the integration UUID as `entityId`, and the authenticated operator as `actorUserId`. Proposed new event types are `HANDOFF_INTEGRATION_CAPABILITY_PROVISIONED` (`NONE → TENANT_PIC`) and `HANDOFF_INTEGRATION_CAPABILITY_REVOKED` (`TENANT_PIC → NONE`). Proposed safe metadata is limited to `integrationCode`, `previousCapability`, and `newCapability`; use `source = SYSTEM` plus a generated UUID request/correlation ID for a non-HTTP invocation.

`clientId = NULL` and `buildingId = NULL` are the natural values for this integration-wide operation, but the shared helper's frozen contract says null-client events are for SaaS Control Plane events, not this Handyman Operations event (`src/modules/operational-events/index.ts:26-45,175-181`). Do not fabricate a customer/building scope. The Operational Events owner must explicitly confirm that a global Handyman Operations event may use this null-client classification (or specify an existing approved global audit classification) before implementation. Event names and this scope are **not** represented as existing events.

## 7. Revocation, rotation, and rollback contract

1. **Normal revocation:** an operator holding `integration.capability.provision` transitions the integration to `NONE`; persist the matching event in the same transaction. Migration 0441's trigger revokes all live PIC sessions when `TENANT_PIC` is removed. Keep the integration row and immutable session history.
2. **No resurrection:** later re-enabling `TENANT_PIC` does not restore revoked sessions; new admission requires a new valid assertion/session.
3. **Secret removal order:** after a successful `NONE` commit, Operations removes/rotates the runtime secret. Removing the HMAC secret alone blocks new signed admissions but does not invalidate already-issued PIC sessions. For a compromised key, `NONE` is required to revoke current sessions before/while rotating; do not rely on key rotation alone.
4. **Pre-commit failure:** stage the secret only through the approved external Operations mechanism. If the database transaction fails, no grant/event commits; the external process must remove the staged secret. Because current integration creation and capability service are not both transaction-aware, later implementation must add the smallest `PoolClient` plumbing needed to make create/change/audit atomic.
5. **Migration rollback:** migration 0441 `down` refuses if any PIC session history exists or an integration still holds `TENANT_PIC`. Once session history exists, use a forward fix; never delete the session evidence or weaken the guard to make rollback pass.
6. **Audit outage:** no unaudited capability change is approved. The proposed fail-closed transaction means an audit write failure aborts the transition. A break-glass revoke that bypasses audit is not part of this freeze and would require separate authority approval; secret removal alone is not equivalent to revoking current sessions.

## 8. Implementation readiness decision

**IMPLEMENTATION BLOCKED — do not implement or provision yet.** The owner-approved design is frozen, but approval does not establish the following operational evidence:

1. **Initial RBAC grant path (authority blocker):** provide/verify an existing suitable Operations role and the authorized non-Platform-Admin grantor/path that can register and assign `integration.capability.provision`. If the deployed system has no suitable Operations role, explicitly authorize the minimal new role and its Operations-controlled bootstrap path first. Do not use `PLATFORM_ADMIN` as a workaround.
2. **Secret delivery path (security blocker):** identify the existing Operations-controlled secret manager/runtime injection workflow for `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>`, including deployment to all verifying instances and rotation/revocation evidence. The code only reads `process.env`; no provider or delivery mechanism is verified.
3. **Non-HTTP authenticated invocation:** identify the already-approved way the existing authenticated Operations session reaches the server-side command without introducing a new auth mechanism or exposing a bearer token. A session resolver exists; the command/credential channel does not.
4. **Audit classification:** obtain Operational Events approval for the global null-client classification and confirm the proposed event taxonomy/correlation fields. The helper's transaction support is verified; this G9 event/scope is not.

No production code or migrations were changed. No tests, typecheck, full suite, PR, or deploy were run. B12 remains OFF, S1 staff decision remains 403, and no automatic grant, PIC binding, or quotation approval is introduced.
