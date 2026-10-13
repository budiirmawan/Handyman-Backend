# CR-HM-FIELD-ASSIGN-01 PART 01B — Inspector authority verification

Baseline: `8d4d4ebb593015c8ac046f8c74896ba9e3c0d570`, branch `arena/d3f14d02-handyman-backend`; clean before work.

## Verified authority and bounded fix

- `handyman-visit-api.service.ts` derives Client/Building from the request, checks the operator with `assertBuildingScopedResourceAccess`, and requires the proposed inspector's `users.status='ACTIVE'`.
- The resource previously used `canAccessBuilding`, which compares Building alone, whereas the established resource authority compares the exact Building **and Client**. Replaced that predicate with existing `canAccessBuildingScopedResource`, keeping its existing 409 response. This rejects an inspector context whose current Client differs from the request's Client (including context drift), without adding qualifications or permissions.
- Shared scope resolution requires an ACTIVE user-building assignment and ACTIVE Building, with Client derived through Building → Property → Client. User identity is global, not a caller-owned tenant/PIC identity; no new user-to-tenant membership rule is inferred.
- HTTP proposal writes and result writes require authenticated local session + `tenant_company.manage`; reads require `tenant_company.read`. `resolveSessionContext` revalidates `userStatusCanLogin` (ACTIVE only). Inspector resource identity does not itself grant these management permissions.
- Result submission uses session actor, request-derived Client/Building, immutable one-per-request inspection record and atomic INSPECTION_REQUIRED → DIAGNOSIS + audit. Actual HTTP input is `{result,notes}`; caller actor/context fields are not forwarded.
- PART 01A field identity remains unchanged: session user must match an INSPECTION appointment's INSPECTOR_USER resource; only CONFIRMED/IN_PROGRESS visits appear under the shared Building/Client authority.

## Precise authority blockers — behavior intentionally unchanged

1. **Qualification/role:** no authoritative Inspector role, skill requirement or qualification binding is consumed by the proposal/result services. R1C explicitly defers inspector skill verification to future confirmation. A named role or generic workforce skill is not sufficient evidence to invent eligibility. Business owner must define the qualification source, applicability and evaluator before activation.
2. **Result delegation/visit linkage:** the result is an administrative request-scoped record, not an assigned-inspector-only command. It has no appointment/attempt FK and does not require a confirmed visit. Restricting it to a proposed resource would equate proposal with assignment and remove the existing authorized Operations workflow. Business owner must decide direct Inspector vs delegated Operations submission, required completed-visit evidence, and any new field capability before changing this behavior.
3. **Provider representation:** Inspector resource is a local user, not a verified provider delegate. No authority chain proves which provider may select or submit for this user. Do not infer this from crew/FM assignments; provider delegation requires its own approved policy.

Booking confirmation remains disabled. Execution Scope remains the crew target; FM Work Order stays independent. No consent simulation, acknowledgement/decline lifecycle, feed change, new table, migration or endpoint.

## Focused validation

`tests/handyman-inspector-authority.test.ts` exercises the registered proposal/result routers with actual authentication/RBAC middleware and services, isolated PostgreSQL TEMP fixtures, and fixture repository adapters for session/permission/shared Building context. It checks inactive/missing resource users, wrong Building/Client contexts, inactive Building/assignment, unauthorized actors, valid proposal scope, spoofed actor/context, and administrative result submission without a visit.

Validation on 2026-10-14:

- `NODE_ENV=test LOG_LEVEL=error npx --no-install tsx --test --test-concurrency=1 tests/handyman-inspector-authority.test.ts tests/handyman-visit-r1c/proposal-validation.test.mjs tests/handyman-field-feed-contract.test.ts tests/handyman-field-feed-authority.test.ts` — **40/40 passed, zero skips** (18 Inspector authority, 5 existing DTO, 17 PART 01A feed tests).
- The single Client-mismatch regression was also run against the original baseline service: it failed as expected, returning **201 instead of 409**. The fixed service was restored byte-for-byte afterward.
- `npm run typecheck` — passed, executed once.
- No application migrations or full suite were run.


## Continuation — existing worker registration admission (2026-10-14)

Business direction: Handyman Operations selects existing registered external workers;
no marketplace/provider-delegation engine. Baseline `ef4def385223b4a6a635407c591cd0540526ff92`.

Verified registration chain: Handyman Worker Context → Provider Context → Vendor;
Worker Context → Workforce Profile → Organization/Client; Vendor ↔ Workforce Binding.
The existing vendor binding admission requires EXTERNAL workforce and ACTIVE master
identities. Binding windows remain authoritative. Operational Building placement
(`workforce_building_assignments`) is explicitly separate from User Building data
access and is effective-dated; helpers with no User login remain supported.
No qualification, freelancer status, role or onboarding lifecycle is invented.

Added a read-only, transaction-executor-aware admission query over those existing
records. Inspector proposal now requires a currently registered ACTIVE EXTERNAL
person under an ACTIVE provider/vendor, effective vendor binding, matching Client,
and effective placement in the exact ACTIVE Building, in addition to PART 01B's
ACTIVE user and exact User Building access checks. The worker context must already
exist; names, employee codes, role strings and caller context cannot create authority.

Crew assign/reassign and execution proposals revalidate **every ACTIVE membership**,
not only the Lead: same Client/provider, current registration, workforce status and
Building placement. The actual latest Lead must have an ACTIVE linked User and explicit ACTIVE User
Building access to the target Building;
inactive/missing/latest-ineligible designations never fall back. Linked helper Users
must be ACTIVE, but a registered helper with explicitly NULL userId remains valid.
The existing Lead resolver reuses this validation for current field command authority.
Inactive historical memberships are not task members. Execution proposals also
require exact allocation/Crew Client and provider linkage. Registration/placement is
checked at current admission time; this does not certify future-slot capacity,
qualification, tenant consent or dispatch readiness.

Assignment mutation, supersession and audit still share the existing transaction.
Invalid replacement leaves the previous ACTIVE row/history and audit intact.
No migration, table, endpoint, status, permission or idempotency contract changed.
PART 01A feed implementation and administrative inspection-result submission remain
unchanged. ACTIVE allocation does not mean confirmation, dispatch or acceptance.

Focused evidence: 81/81 tests passed, zero skips (27 Crew registration/assignment/
proposal cases, 32 Inspector authority cases, 17 PART 01A feed regressions, 5 R1C DTO
cases). Tests use isolated PostgreSQL TEMP fixtures, not production onboarding or
application migrations. Baseline services reproduced two failures: an inactive
Inspector workforce profile was accepted (201 instead of 409), and an inactive
Crew helper was assigned. Fixed source restored after reproduction. Typecheck passed.

Genuine remaining gates: authenticated tenant schedule-selection/confirmation and
atomic live booking wiring; authoritative Dispatch Release before Terima/Tolak;
qualification policy if skill-specific admission is required. Existing registries
must contain active effective vendor bindings and Building placements before admission;
legacy missing/stale records now fail closed, with no fabricated registration,
automatic seed/backfill or onboarding engine. Provider representation is not a new
engine requirement for this Operations-authored selection flow.
