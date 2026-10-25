# CR-HM-BE-IAM-E2E-AUDIT-01 — PART05: dispatch clearances

2026-10-25 · Branch `arena/3a9f4872-handyman-backend` · Starting HEAD `631f1e984c61cc48881e8e4cc535e0e0b9c91528` (verified clean).
This follows the user's PART05 dispatch/permit/access task, superseding the earlier roadmap numbering; no operational-actor audit was repeated.

## Outcome: BLOCKED on trusted exemption policy; fail-closed patch delivered

Existing `handyman_permit_readiness` and `handyman_unit_access_readiness` provide authoritative authorization/location/window facts. Neither those contracts nor the request/booking authority contains a trusted **required / not-required / exempt** decision or required permit-type policy. The previous absence-means-clear comment was not such a source.

**Exact blocker:** safely distinguishing an optional clearance from a required-but-missing clearance needs an approved, authenticated, Building/request-scoped applicability/exemption authority. No such fact is invented from absence, notes, role, request-body flags or another Building's row. Missing facts now fail closed. Consequently genuinely exempt execution workflows cannot yet be enabled/preserved as exemptions; this is not a complete applicability-policy implementation. No migration/configuration/endpoint was introduced to hide that dependency. Production remains NO-GO.

## Bounded patch

- Replaced both hard-coded TRUE clearances with consumption of the **existing readiness repositories**. Require ACTIVE records matching request, Client, Building and live unit location chain, covering the whole confirmed execution visit.
- Dispatch binds the current assignment's crew, exact request/Building and nonexpired confirmed visit. A caller-supplied `appointmentId` cannot replace the visit Backend evaluated. Existing material/provider/crew/conflict gates and duplicate-release conflict semantics remain.
- CHECK_IN, START_WORK and RESUME re-prove the active release's exact visit and current clearances inside their write transaction. New execution requires the current visit window; advance release of a future covered visit remains allowed.
- Scope/visit/readiness locks serialize writes and readiness supersession; locked readiness is re-read, and wall time is sampled **after** waits. Session scope/Lead/Building checks use the same transaction through optional executor propagation.
- Same-key acknowledgments remain historical replays, not new work or a new clearance assertion. New work is denied after expiry/revocation/cancellation. Safe PAUSE is not blocked by expired clearances. Existing routes, payloads, readiness CRUD/history, arrival evaluator and PART02–04 security implementations remain.

## Files — 8

- `src/modules/handyman-dispatch/handyman-dispatch.service.ts` — shared clearance consumer, exact evaluated visit, execution recheck.
- `src/modules/handyman-work-sessions/handyman-work-session.service.ts` — transactional checks at check-in/start/resume; replay/safe-stop separation.
- `src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts` — optional transaction propagation through current-Lead resolution.
- `src/modules/workforce/workforce.repository.ts` — optional executor for existing profile lookup; default callers unchanged.
- `tests/handyman-dispatch-authority.test.ts` — clearance negatives/valid release, forged flags, foreign scope, schedule, concurrent release and revocation lock race.
- `tests/handyman-work-session-commands.test.ts` — real arrival/session flow with expired/superseded clearances, restoration, cancellation, replay, safe pause and zero partial session writes.
- `tests/helpers/handyman-dispatch.ts` — existing fixture now supplies explicit authorizations through the real readiness services and a current execution window; not an exemption or tenant-slot issuer proof.
- `docs/audits/CR-HM-BE-IAM-E2E-AUDIT-01-PART-05.md` — this report.

## Focused evidence

**Final: 61 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED; 15 suites**, 102.2 seconds. `npm run typecheck` and `git diff --check`: PASS.
Disposable embedded PostgreSQL only; existing migrations initialize test databases. No full suite, new migration, deployment or production mutation.

Run `NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1` with this exact selection against a disposable test database:

```text
tests/handyman-dispatch-authority.test.ts
tests/handyman-work-session-commands.test.ts
tests/handyman-work-session-workclock.test.ts
tests/handyman-permit-readiness.test.ts
tests/handyman-unit-access-readiness.test.ts
tests/handyman-bast-worker-api.test.ts
```

The final run used an ephemeral bootstrap for the optional-DB suites; no unavailable-database skips. Foreign/corrupt readiness consumer cases mock repository facts, not authentication or writes; real supersession/revocation, row-lock race and real QR-arrival/session cases complement them. Denials compare dispatch/session/event/audit facts; existing work-clock/BAST regressions pass. Development failures: executor typings corrected; first run 46/47 (test used a nonexistent fixture request property), next 60/61 (cancellation fixture omitted atomic reservation release); both fixtures fixed without weakening production guards.

## PART06 handoff — not started

First obtain the scoped trusted required/exempt policy (including permit type) before enabling optional-clearance execution; do not infer exemption from missing data. Then separately authorize any remaining arrival-consumption hardening: `findVerifiedArrivalResultId` still accepts historical scope-level VERIFIED results rather than requiring the current actor/assignment. Its query semantics were deliberately not expanded in this focused clearance patch. No PR until FINAL REVIEW. **STOP after PART05.**
