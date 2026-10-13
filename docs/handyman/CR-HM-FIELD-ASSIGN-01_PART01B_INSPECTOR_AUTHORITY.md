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
