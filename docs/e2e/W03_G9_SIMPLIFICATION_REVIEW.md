# W03 G9 — Simplification Review

| Field | Value |
|---|---|
| Result | **No business-authority decision is needed for a test-only fixture. Production integration readiness remains separate and uncertified.** |
| Baseline verified | Local HEAD and remote both `0f864da9dd695258c487f14c68a857343652fdee`; clean worktree. |
| Branch | `arena/b4a8612c-handyman-backend` |
| Scope | Existing BM integration, PIC session, binding, and integrated E2E fixture only. No code/test changes. |

## Owner clarification applied

Handyman owns its integration configuration. BM is the integration/customer channel; Tenant/PIC is the quotation decision actor. This is **not** SaaS tenant provisioning: the BM integration is channel-wide, while Handyman resolves and enforces tenant-company/building/PIC facts from each signed representation and the quotation's explicit approval binding.

## Simplest existing configuration

The existing runtime needs one ACTIVE `handyman_handoff_integrations` row for the BM/PIC channel with `actor_capability = 'TENANT_PIC'`, plus the per-code HMAC secret in `HANDYMAN_HANDOFF_SECRET_<NORMALIZED_INTEGRATION_CODE>`. The in-repo primitives are `handoffRuntimeRepository.createIntegration()` and `handymanCareActorService.setIntegrationActorCapability()`; neither creates a SaaS tenant, a per-company integration, an RBAC role, nor a PIC binding. The config reader consumes the named environment variable. This describes the existing Handyman integration configuration, not proof of a production operator/runbook or secret deployment.

## Test-only fixture is legitimate for integrated E2E

The explicit test fixture already exists in `tests/helpers/handyman-pic-fixtures.ts:23-65`: it creates a unique `TEST_PIC_*` integration, sets `TENANT_PIC`, generates a random test secret, installs it in `process.env` under the existing normalized name, signs a short-lived assertion, and removes the variable in `finally`. `tests/handyman-pic-workspace-session.test.ts:136-146` independently uses the same isolated fixture pattern and its tests exercise the actual session routes. This is legitimate **test setup only** under the owner clarification; it grants no user/role permission and creates no PIC binding or approval. It does not certify or simulate production Operations provisioning.

For a route-level 03H-05 PASS, reuse only the integration/secret setup pattern, then use the real HTTP flow:

1. Create the isolated test tenant/building/PIC and quotation/request facts with existing test factories.
2. Create a unique BM-channel integration fixture with `TENANT_PIC` and an ephemeral environment secret. Do not emit or persist the secret.
3. Build and sign the existing PIC representation, then call `POST /api/v1/handyman/pic/session` and use the returned token through the actual PIC read/decision routes. The 03C route still checks HMAC, `ACTIVE + TENANT_PIC`, replay/window constraints, and resolves Handyman-owned context.
4. Grant the quotation binding as an explicit staff action through the existing binding path; do not auto-bind. Verify the PIC decision, read-only decision/scope/audit evidence, foreign-context refusals, and the staff decision 403.
5. Keep B12 OFF. Use an isolated database and remove the ephemeral environment key during teardown.

`bindAndAdmitFixturePic()` and `decideFixturePic()` in the helper use the production binding/admission/decision services directly. They remain appropriate for service-level consumer tests; for 03H-05 HTTP coverage, construct the fixture state but send admission and decision through the existing routes rather than substituting direct service calls.

This test-only bootstrap sets only the initial test integration configuration. It does **not** skip or weaken PIC session validation, quotation binding eligibility, maker-checker rules, decision attribution, audit, S1, or migration 0441 guards.

## Production readiness is a separate claim

A green isolated E2E with this fixture may be reported as **test-only journey PASS**. It must not be described as proof of an authorized production provisioning process, deployed BM secret, production PIC session, rollout readiness, B12 enablement, or E2E certification. Production still requires the Handyman-owned operational process to establish the integration configuration and deploy the per-integration secret in the target environment; this review does not claim those external actions occurred.

The current `tests/handyman-w03-03h05-integrated-journey.test.ts` remains **SKIP 1/1** until a bounded test-only journey is implemented and run. Its existing G9 skip rationale is superseded only for the test fixture by this owner clarification; no production authority is changed. B12 remains OFF, S1 remains 403, and migration 0441 remains forward-fix-only.

No tests were run and no code, migration, or authority state was changed for this review. No full suite, PR, or deploy.
