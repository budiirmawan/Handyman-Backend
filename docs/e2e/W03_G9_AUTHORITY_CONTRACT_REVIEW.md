# W03 G9 — Authority Contract Review

| Field | Value |
|---|---|
| Status | **REVIEWED — proposed contract is partly consistent; not frozen pending the approvals in §6.** |
| Expected / verified baseline | `9f80e97e5ecf28c61f25d5cdd2a0c9866a5114ba` |
| Branch | `arena/b4a8612c-handyman-backend` |
| Date | 2026-10-11 (Asia/Jakarta) |
| Scope | Architecture review/documentation only; no production code, tests, typecheck, migration, or authority grant. |

## 1. Decision status: owner proposals vs verified existing

The earlier owner authorization permits a controlled server-side Operations bootstrap in principle. The seven items below are the **current owner proposals**, not all verified or ratified contracts. Evidence is listed separately so that proposed policy is not mistaken for shipped behavior.

| # | OWNER PROPOSED | VERIFIED EXISTING / review |
|---|---|---|
| 1 | An authenticated Operations Security Administrator provisions integrations. | The session and RBAC primitives exist, but no Operations Security Administrator role/caller is established in the foundation seed or handoff module. The service primitive itself has no operator identity/authentication. |
| 2 | Add `integration.capability.provision`, subject to RBAC architecture review. | RBAC supports dedicated permission codes and deliberately unassigned exceptional permissions. This code does not exist. The foundation seed creates `PLATFORM_ADMIN_ROLE`; no Operations Security Administrator role is seeded. |
| 3 | `TENANT_PIC` is integration-wide for the BM/PIC channel, not per-company. | Consistent with 03C's documented **one integration row for the BM PIC channel** and the current integration schema, which has no client or tenant-company column. |
| 4 | Company/building access remains enforced by existing PIC binding and business authority. | PIC session admission/use resolves an active tenant/PIC/building representation; the quotation binding records the request's tenant/building/space and checks PIC-company eligibility. No integration-wide company scope is currently modeled. |
| 5 | Secret delivery uses an approved Operations runtime environment/secret-manager workflow; never plaintext DB. | Verified code reads `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>` from process environment and does not store it in the integration table. The approved secret manager and deployment workflow are external to this checkout and remain unverified. |
| 6 | No HTTP endpoint and no Platform Admin dependency. | PART 07 explicitly says server-side Operations provisioning and no HTTP surface. No endpoint is needed for this proposal. Initial RBAC grant/role provisioning still has an unresolved Platform Admin dependency risk (see §6.1). |
| 7 | B12 OFF, S1 staff decision 403, no auto-binding or auto-grant. | These controls are unchanged by G9. The capability service only changes integration actor capability; it does not bind a PIC, decide a quotation, or grant an RBAC permission. |

**Consistency conclusion:** proposals 3, 4, 6, and 7 fit the current BM-wide attestation model and downstream PIC/business guards. Proposals 1, 2, and 5 need concrete caller, grant, and secret-delivery arrangements before implementation. The current RBAC assignment path also needs review to satisfy “no Platform Admin dependency.”

## 2. Proposed authorization contract (NOT YET IMPLEMENTED)

### Verified primitives

- `sessionService.resolveSessionContext(rawToken)` verifies the existing local bearer session, expiry, and active user (`src/modules/auth/session.service.ts:49-69`). `authenticationMiddleware` uses this mechanism for HTTP.
- `permissionService.resolvePermissionsForUser(userId)` resolves current active RBAC permissions; `requirePermission(code)` is the existing HTTP default-deny gate (`src/modules/permissions/permission.service.ts:113-126`; `src/modules/auth/rbac.middleware.ts:14-44`).
- The existing `setIntegrationActorCapability()` service accepts only `{ integrationId, capability }`; it performs no caller authentication/authorization (`src/modules/handyman-care-actors/handyman-care-actor.service.ts:89-108`).
- `integration.capability.provision` is **not** registered. `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` and the seed's “skip default role grant” loop are the existing pattern for exceptional Ops authorities (`src/database/seeds/foundation-access.seed.ts:773-794,851-889`).

### Proposed CLI authorization flow

1. Consume an **existing** local bearer session through `sessionService.resolveSessionContext`; derive the operator ID only from the resolved context. Never accept a free-form `operatorUserId` as proof of identity.
2. Require the dedicated `integration.capability.provision` permission through `permissionService.resolvePermissionsForUser`. Unknown, expired, inactive, or unauthorized operators fail closed before any write.
3. The permission is global to the BM/PIC-channel integration. There is no `tenantCompanyId` or `buildingId` argument to this bootstrap. Company/building boundaries continue to be checked when the signed PIC representation is admitted and when a PIC uses the workspace/quotation binding.
4. No call to binding APIs, quotation decision APIs, or role-permission assignment APIs is part of bootstrap. Granting the bootstrap permission to the operator is a separate, explicit RBAC administration action.

**Not verified:** a CLI does not currently exist and no approved token-ingress convention exists for it. The CLI must not accept bearer tokens in argv, shell history, or logs. Operations Security must approve a safe way to supply an existing session credential (or identify an existing trusted invocation boundary); do not create a new machine identity/authentication scheme here.

**RBAC review required:** if approved, register the permission and add it to `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`, so it is not automatically inherited by `PLATFORM_ADMIN` or any tenant-facing role. Assign it only to the approved Operations Security Administrator role. The foundation seed creates `PLATFORM_ADMIN_ROLE` and default `permission.manage` authority; it does not define the proposed Operations Security Administrator role. The existing role-permission assignment API is gated by `permission.manage`; creating/assigning the role or assigning it to a user separately requires `role.manage`. Both are in the foundation permission catalogue and are default-granted to `PLATFORM_ADMIN` by the seed. The initial Operations-owned grant path must therefore be explicitly resolved without violating the proposed “no Platform Admin dependency.”

## 3. Company/building scope contract

The proposals are internally consistent **if “scope” means the downstream PIC/business representation, not a tenant-scoped integration**:

- One active BM integration with `TENANT_PIC` can attest PIC representations across the BM/PIC channel. The integration record itself is not company-bound; that is both the current schema and the 03C “one integration row” design.
- Admission checks `ACTIVE + TENANT_PIC`; the session service resolves the tenant company, PIC, building and optional space against Handyman-owned active records. Every session use rechecks integration capability, tenant status, PIC-to-tenant membership, and current session authority (`src/modules/handyman-pic-session/pic-workspace-session.repository.ts:49-64,96-133`).
- A quotation binding remains separate: it is an explicit, auditable decision over a particular quotation/request and tenant/building lineage. The bootstrap does not bind the PIC or expand the binding caller's authority.

Therefore do **not** add a company field to the integration row or claim that the provisioning command itself is company-scoped under proposal 3. This owner proposal supersedes the earlier direct per-company-scope concern in the G9 stop report; no company-scope schema change is justified if it is ratified. The BM integration attests; Handyman resolves the represented PIC/context and enforces downstream binding and business scope.

## 4. Proposed audit contract (event names/scope still need approval)

### Verified existing audit support

`recordOperationalEvent()` inserts an operational event with `actorUserId`, `clientId`, `buildingId`, entity identity, metadata and request/source correlation. It accepts a transaction executor and an explicit `SYSTEM`/`SCHEDULER` correlation override outside HTTP; its metadata scrubber removes selected top-level sensitive keys. The capability setter currently emits no event. `withTransaction()` is available (`src/database/transaction.ts:8-23`), and existing Handyman binding writes record their operational event in the same transaction as the binding.

### Proposed event shape

For a BM-wide capability change, record one append-only event in the same transaction as the database state change:

| Field | Proposed value |
|---|---|
| `eventType` | `HANDOFF_INTEGRATION_CAPABILITY_PROVISIONED` for `NONE → TENANT_PIC`; `HANDOFF_INTEGRATION_CAPABILITY_REVOKED` for `TENANT_PIC → NONE` (**new event names; proposed**) |
| `entityType` / `entityId` | `HANDOFF_INTEGRATION` / integration UUID |
| `actorUserId` | User ID from the resolved authenticated Operations session |
| `clientId` / `buildingId` | `NULL` / `NULL`, because the capability is BM/channel-wide and the integration has no single customer/building |
| `source` / `requestId` | `SYSTEM` / generated operation correlation UUID for the non-HTTP command |
| Metadata allowlist | `integrationCode`, `previousCapability`, `newCapability`; no secret, token, HMAC, or raw environment data |

The global `clientId = NULL` classification must be confirmed with the Operational Events/audit owner: existing comments explicitly discuss null-client events for SaaS Control Plane activity, not this Handyman Operations event. Do not invent a customer ID or building to make the event appear scoped. The event itself is not an authorization check. Audit insert failure should abort the capability transaction; whether emergency revocation must be allowed during audit-store failure is an explicit policy decision (§6.3).

## 5. Secret delivery and rollback contracts

### Secret-delivery contract

**OWNER PROPOSED:** Operations' approved runtime secret manager creates/stores the HMAC secret and deploys it as `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>` to the bootstrap process and every runtime that admits PIC sessions. The CLI accepts only nonsecret integration fields (such as the code and display name), never the secret; it fails before database mutation if the configured secret is absent, and never emits the value in output, logs, audit metadata, database columns, or argv. The secret-manager's own audit is separate from the Handyman operational event.

**VERIFIED EXISTING:** `handoffIntegrationSecretEnvName()` and `readHandoffIntegrationSecret()` implement the environment-variable convention (`src/modules/handyman-handoff/handoff-runtime.config.ts:20-65`); migration 0375 stores integration trust metadata, not secret material. No secret-manager client, approved workflow, or test-environment equivalent is present in this checkout. Name/approve that external workflow before enabling the CLI. Never substitute a test-only `process.env` assignment as production provisioning.

### Database transaction and rollback contract

Proposed sequence: pre-provision the secret through the approved Operations secret manager; then run one database transaction that creates/loads the integration, changes its capability, and writes the audit event. No PIC session can be admitted until the integration has `TENANT_PIC`; integration creation currently defaults to ACTIVE with capability `NONE`.

`withTransaction()` and transaction-aware audit/capability repository methods exist, but `handoffRuntimeRepository.createIntegration()` has no `PoolClient` parameter and the exported capability service does not expose one. A later implementation must add the smallest transaction plumbing needed so integration creation, capability change, and mandatory audit commit/rollback together. If the transaction fails, no capability grant or audit event commits; Operations must remove the already-staged secret version. No plaintext secret is written to a transaction or database.

For post-provision revocation/rollback, set the integration capability to `NONE` and write its audit event atomically. Migration 0441's trigger immediately revokes every live PIC workspace session when the integration loses `TENANT_PIC`; revoked session history is immutable and re-enabling the capability never resurrects those sessions (`0441_handyman_pic_workspace_sessions.ts:130-153`). Remove the runtime secret only after the `NONE` transaction commits. Removing the secret alone blocks new signed admissions but does **not** revoke already-issued PIC sessions, which are checked against integration status/capability, not the HMAC secret.

Do not delete integration or PIC session history as rollback. Migration 0441 `down` refuses if any PIC session rows exist or any integration still holds `TENANT_PIC`; after session history exists the migration is forward-fix-only (`0441_handyman_pic_workspace_sessions.ts:180-193`). Operational revocation is capability downgrade, not migration rollback.

## 6. Explicit approvals still required before implementation

1. **RBAC/role assignment:** ratify `integration.capability.provision`, whether it authorizes both provision and `NONE` revocation (or whether a separate revoke permission is needed), and the named Operations Security Administrator role/grant path. Resolve how the initial grant happens without a Platform Admin dependency; no such role or initial grant path is verified in this repository.
2. **CLI operator credential ingress:** approve the safe mechanism for the CLI to consume an existing session credential without argv/history/log exposure, or identify an already-controlled invocation boundary. The existing session resolver is verified; a CLI authentication adapter is not.
3. **Audit taxonomy and failure posture:** approve the proposed event names and global null-client classification, and decide whether an emergency `TENANT_PIC → NONE` revoke must be possible if the operational audit store is unavailable. Default proposed behavior is atomic state+audit and fail closed.
4. **Secret-management workflow:** identify the approved Operations runtime secret manager, deployment ordering/propagation to all instances, audit link, and isolated-test equivalent. The env-var read contract is verified; provisioning/rotation tooling is not.
5. **Permission removal and key compromise:** confirm whether removing the operator permission affects only future bootstrap actions (proposed; existing integrations remain until explicitly downgraded), and ratify the emergency key-compromise sequence. Existing behavior requires capability `NONE` to revoke active PIC sessions before/while rotating a compromised secret.

After these approvals, implementation can remain a no-HTTP server-side Operations command using the existing integration, capability, session/RBAC, transaction, audit, and secret-config primitives. No permission auto-grant, PIC auto-binding, quotation approval, or B12 enablement is part of it.

## 7. Guardrails

No implementation or tests were run for this review. B12 remains OFF; S1 staff decision remains 403; PIC binding authority is unchanged. This document distinguishes owner proposals from verified behavior and is **not** a ratification of the remaining items in §6.
