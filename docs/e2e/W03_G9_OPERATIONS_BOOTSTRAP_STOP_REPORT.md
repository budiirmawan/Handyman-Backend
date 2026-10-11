# W03 G9 — Operations Bootstrap Stop Report

| Field | Value |
|---|---|
| Status | **STOPPED BEFORE IMPLEMENTATION — existing infrastructure does not identify an authorized provisioning permission/caller or company-scoped integration contract.** |
| Expected baseline | `2e5c20deb5d2e7bde17c22e88980e2d6cb34f9f1` |
| Verified HEAD / remote | `2e5c20deb5d2e7bde17c22e88980e2d6cb34f9f1` / same |
| Branch | `arena/b4a8612c-handyman-backend` |
| Initial worktree | Clean |
| Scope | Targeted discovery only; no production code, test, migration, or authority change. |

## Evidence

### Existing Operations authority

- PART 07 calls integration actor-capability provisioning **server-side Operations**, not an HTTP request, and explicitly says **no HTTP surface**: `src/modules/handyman-care-actors/handyman-care-actor.service.ts:20-33`; `docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md:126-127,315-320`.
- `setIntegrationActorCapability({ integrationId, capability })` validates the enum then updates the integration row; there is no operator identity, authorization check, tenant scope, or audit in this primitive (`handyman-care-actor.service.ts:89-108`; `handyman-care-actor.repository.ts:129-142`). No production caller was found. Existing callers are test fixtures.
- `handoffRuntimeRepository.createIntegration()` creates an ACTIVE, unscoped integration; the table has no `client_id` or `tenant_company_id` (`handoff-runtime.repository.ts:28-39`; migration `0375_create_handyman_handoff_runtime.ts:24-38`). Existing PIC design describes **one integration row for the BM PIC channel**, not one row per tenant (`docs/e2e/W03_PART03C_PIC_SESSION_SECURE_HANDOFF.md:117-120`).
- `TENANT_PIC` is an integration attestation capability, not a business permission. PIC admission checks ACTIVE + TENANT_PIC, while the session resolves the supplied tenant/PIC/building representation independently (`handyman-care-actor.types.ts:15-25`; `pic-workspace-session.repository.ts:49-64`; migration `0441_handyman_pic_workspace_sessions.ts:47-54`). No integration-to-company association exists to restrict the capability to one tenant.

### Existing authentication, authorization, scope, audit, and secret primitives

- Local-user session authentication **does exist**: `sessionService.resolveSessionContext(rawToken)` verifies the active session and user (`src/modules/auth/session.service.ts:49-69`). Effective RBAC permission lookup exists (`src/modules/permissions/permission.service.ts:113-126`), as does exact Building assignment scope (`src/modules/context-access/context-access.service.ts`).
- However, no existing permission grants Operations authority to provision handoff integrations. Seeded `handyman.operations.request.triage` is explicitly a triage permission; `tenant_company.manage` is tenant-company management; `integration_webhook.manage` is specifically outbound webhook endpoint/secret administration (`src/database/seeds/foundation-access.seed.ts:253-270,712-721`). Reusing one for this trust-provisioning action would expand or conflate its authority. No `handyman.handoff.integration.*` permission or production caller was found.
- The existing `/handyman/care-actors/:id/permissions` router is for permission grants to Care actors, authenticated with `permission.manage`; it does not administer handoff integrations (`handyman-care-actor-permission.routes.ts:12-26,39-71`). The handoff HTTP router exposes signed assertions and attribution only (`handyman-handoff/handoff.routes.ts`); it has no provisioning route, consistent with PART 07.
- Append-only operational audit can record `actorUserId`, `clientId`, `buildingId`, and safe metadata (`src/modules/operational-events/index.ts`). This is an available audit primitive, not an authorization source; the capability setter currently emits no event.
- The existing secret boundary reads `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>` from environment configuration and does not store the secret (`handoff-runtime.config.ts:1-31`; migration 0375 comment/schema). No secret-manager/bootstrap integration was found that creates, stores, or deploys a new secret. Existing test fixtures set process environment directly; that is not a production secret-delivery procedure.

## Precise blocker

A local session token could identify an operator, but the repository has **no existing authorization code that means “may provision a BM handoff integration with TENANT_PIC capability.”** The owner decision authorizes an Operations bootstrap in principle; it does not map that act to an existing RBAC permission or define who receives it. The current `tenant_company.manage`, request-triage, and webhook permissions do not safely substitute.

There is a second scope mismatch: the requested company scope cannot be enforced on an integration using current schema/primitives. The integration is BM/channel-scoped, has no tenant/company key, and is intended to represent a single PIC-channel integration. Checking an operator against one tenant/building at bootstrap time would not constrain that integration's later attestations to that company. Making it company-scoped would require an authority/model decision and enforcement change, not merely a CLI argument or audit metadata.

Finally, a CLI cannot safely provision a new signing secret from this repository alone: the runtime knows how to **read** the existing environment variable, but the secret's creation and deployment must be performed by an identified Operations secret-management process.

## Stop decision and smallest next step

No CLI/bootstrap, permission grant, test change, or production edit was made. Implementing one now would require inventing at least the operator permission and silently choosing the company-scope semantics; both are expressly outside the grounded existing authority.

Before implementation, the authority owner / Operations Security must confirm:

1. **Operator authorization:** which existing Operations principal/permission is allowed to create and enable a PIC attestation integration. If none exists, explicitly authorize a dedicated permission and its grant/assignment owner; do not reuse an unrelated permission.
2. **Scope semantics:** whether authorization is BM-wide for the documented single PIC-channel integration, or whether the integration must be tenant/company-bound. If tenant-bound, ratify the required enforcement model; current storage cannot enforce it.
3. **Secret lifecycle:** which existing Operations secret manager/environment deployment path creates and installs the secret for both runtime and isolated-test environments without outputting plaintext.

If the owner confirms BM-wide Operations authority, the smallest implementation can reuse the existing integration repository, capability service, session/RBAC, context-scope and operational-event primitives, plus the confirmed secret-delivery path—without a public HTTP endpoint or Platform Admin feature. If tenant/company binding is required, pause for a separate authority/model decision before changing the schema or tests.

B12 remains OFF; S1 staff decision behavior and PIC approval-binding authority are untouched. No tests, typecheck, full suite, PR, or deploy were run.
