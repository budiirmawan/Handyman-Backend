# W03 G9 — Authority Discovery / Architecture Correction

| Field | Value |
|---|---|
| Status | **DISCOVERY COMPLETE — operational caller/bootstrap is not present in this repository; external Operations process unverified.** |
| Baseline checked | `7de5d78fa94d408e895609a2627d75453c7bc1ae` |
| Branch | `arena/b4a8612c-handyman-backend` |
| Date | 2026-10-11 (Asia/Jakarta) |
| Scope | Read-only authority discovery; no production code, migration, test, or authority change. |

## Findings

1. **The intended authority is Operations acting server-side—not Handyman Platform Admin.** The CR-HM-01 Amendment 01 design assigns actor-capability provisioning to Operations, explicitly says it is not request-derived, and schedules PART 07 as an “operational provisioning path” with **no HTTP** (`docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md:126-127,315-320`). The PIC decision contract repeats that capability is provisioned by Operations (`docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md:135`).

2. **The backend contains the operational mutation primitive, but no in-repo production caller.** `handymanCareActorService.setIntegrationActorCapability()` is documented as operational registry administration (`src/modules/handyman-care-actors/handyman-care-actor.service.ts:20-33,89-108`). Its input is only `{ integrationId, capability }`; it has no caller identity or authorization context. The repository method updates `actor_capability` (`handyman-care-actor.repository.ts:129-142`). A scoped search found no production invocation of the setter or `handoffRuntimeRepository.createIntegration()`; source occurrences are the service/repository definition and export. No matching integration/capability rows or `TENANT_PIC` references were found in `src/database/seeds`.

3. **Integration creation and secret delivery are separate operational prerequisites.** `handoffRuntimeRepository.createIntegration()` inserts an integration as `ACTIVE` by default and does not assign its capability (`src/modules/handyman-handoff/handoff-runtime.repository.ts:28-39`). The HMAC secret is read from `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>` in process configuration, not from an authenticated provisioning API (`src/modules/handyman-handoff/handoff-runtime.config.ts:1-31`). There is no in-repo production bootstrap that joins row creation, capability assignment, and secret delivery.

4. **`TENANT_PIC` is an integration attestation right, not an application-user permission.** It is in the closed capability vocabulary (`handyman-care-actor.types.ts:15-25`), migration 0441 widens the database check to include it (`0441_handyman_pic_workspace_sessions.ts:47-54`), and PIC session admission requires the integration to be `ACTIVE` and `TENANT_PIC` (`pic-workspace-session.repository.ts:49-64`). The contract says this does not grant business permissions (`CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md:159-161`).

5. **The existing HTTP “care actor admin” surface is a different authority.** `createCareActorPermissionAdminRouter()` handles permission grants to a care actor, authenticated with a local user and `permission.manage` (`handyman-care-actor-permission.routes.ts:12-26,59-71`; mounted at `routes/index.ts:843`). It does not create integrations or set integration actor capability. Reusing it—or a `PLATFORM_ADMIN` role—for G9 would conflate distinct authorities.

6. **Current tests use fixture-level internal provisioning.** For example, `tests/helpers/handyman-pic-fixtures.ts:35-46` directly calls the integration repository and capability service, then adds a test secret to `process.env`; `handyman-pic-workspace-session.test.ts:137-157` follows the same pattern. These are test fixtures, not evidence of a production Operations caller. They prove the downstream PIC path after fixture setup, not who is authorized to provision that trust relationship.

## Root-cause classification

| Candidate | Finding |
|---|---|
| Missing HTTP seam | **No.** The governing design explicitly specifies no HTTP surface for PART 07. Do not add an endpoint merely to close G9. |
| Missing Platform Admin authority/feature | **No evidence; not implied by the contract.** G9 is an integration trust-scope operation, not a local-user business permission. Do not add a Platform Admin role, feature, or grant. |
| Missing administrative bootstrap | **The primitive exists; an in-repo bootstrap/caller does not.** No seed or production caller was found. A bootstrap may exist outside this repository, but that was not verifiable here. |
| Missing authorized caller | **Unresolved in the backend boundary.** Design names Operations as the server-side authority; this checkout does not identify the concrete caller, control, or audit record. |
| Only test setup is wrong | **Possible, not established.** If Operations already has an approved external bootstrap, then the fixture should consume that authorized setup rather than inventing one. No such external process was supplied or verified. |

**Corrected G9 statement:** this is not evidence that a new HTTP or Platform Admin authorization surface is missing. It is an **unverified/missing concrete Operations-side provisioning caller or bootstrap**. The direct test fixture cannot resolve that operational trust decision.

## Smallest options based on existing authority

- **Preferred first step (no backend change):** Operations/Security identify the existing approved server-side bootstrap/runbook, including who controls it and how the integration secret is installed. If it already exists, make the isolated E2E fixture depend on a provisioned test integration from that process. Keep the PART 07 no-HTTP boundary.
- **Only if no such process exists:** the authority owner must approve a controlled Operations-side bootstrap invoking the existing repository/service primitives and define its external authorization, audit evidence, and secret-delivery control. This is a separate implementation decision; do not infer that the setter itself supplies those controls.
- **Not recommended:** add a Platform Admin feature/role, a public HTTP endpoint, an RBAC permission grant, or a migration solely to make test setup convenient.

## Decision required / stop point

The repository evidence establishes the intended **Operations server-side** authority but cannot establish whether an approved Operations bootstrap exists outside the checkout. Operations/Security (or the designated authority owner) must confirm **one** of:

1. the existing external provisioning procedure and its test-environment equivalent; or
2. that no procedure exists, and who may authorize a new Operations-side bootstrap plus its audit/secret controls.

Until that confirmation, G9 remains **UNVERIFIED** and the integrated test stays skipped. This discovery made no changes to B12 (still OFF), S1 (staff decision remains 403), or PIC binding authority. No tests, full suite, PR, or deploy were run.
