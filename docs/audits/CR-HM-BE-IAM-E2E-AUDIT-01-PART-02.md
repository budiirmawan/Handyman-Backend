# CR-HM-BE-IAM-E2E-AUDIT-01 — PART 02

## Privileged permission grant hardening

**Date:** 2026-10-25 (Asia/Jakarta)
**Repository:** `budiirmawan/Handyman-Backend`
**Branch:** `arena/3a9f4872-handyman-backend`
**Verified starting HEAD:** `1bfaabffa6695e8cf40204d0beffe9977eb4fbb6`
**Starting tree:** clean; PART 01 report read before implementation.

> **PART 02: DONE at the local source/test boundary. Production: still BLOCKED / NO-GO.**
>
> Addresses PART 01 **P0-01**, on the existing permission-grant path only. No new
> endpoint, error code, schema migration, role-default expansion, production
> mutation, deployment, PR, or PART 03 implementation. The delivery commit,
> same-branch push, and final clean-tree/remote-HEAD verification are recorded
> in the final handoff; this report is included in that commit.

## 1. Authorization trace and policy

Existing HTTP path:

`POST /api/v1/roles/:roleId/permissions` → authentication → live
`permission.manage` middleware → validated permission UUID → controller passes
`req.auth.userId` → permission service → role-permission repository.

Before this patch, the service checked ACTIVE role/permission and duplicate
assignment, then inserted and audited. It did not apply the existing privileged
revocation rule, recheck grant authority, reject delegated held-role mutation,
or use the role/permission mutation locks.

The existing DELETE guard and role-assignment guard establish the protected
classification: `PLATFORM_ADMIN`, a role already granting any authority-defining
permission, or an authority-defining permission itself. The four codes are
`role.manage`, `permission.manage`, `user.manage`, and `building.manage`.
They are reused, not redefined or extended in this PART.

### Effective policy after the patch

Every authenticated grant requires a currently ACTIVE Backend user and live
`permission.manage` inside the transaction, in addition to the route gate.
Identity, current role memberships, role classification, and the ACTIVE
multi-role permission union come from Backend repositories, not body claims.

| Actor / target | Result |
|---|---|
| No authenticated session | Existing 401 authentication contract. |
| Authenticated actor without `permission.manage` | Existing `403 PERMISSION_DENIED`; no grant mutation. |
| Unknown/inactive service actor, or capability lost after HTTP RBAC | `403 PERMISSION_DENIED` at the mutation boundary. Inactive HTTP sessions retain their existing authentication denial. |
| Non-Owner grants an authority-defining code, targets `PLATFORM_ADMIN`, or targets a role already granting authority | Existing `403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED`, matching revoke. |
| Non-Owner targets any ordinary role they actively hold | `403 PERMISSION_DENIED`, including when another role already supplies the requested permission. Prevents self-elevation and durable self-consolidation. |
| Non-Owner grants a code outside their live effective union to an unheld ordinary role | `403 PERMISSION_DENIED`. |
| Non-Owner grants an ACTIVE code they hold to an unheld ordinary role | Allowed; existing 201 `PublicPermission` response and `PERMISSION_GRANTED` audit. Multi-role union is supported. |
| ACTIVE `PLATFORM_ADMIN` actor with live `permission.manage` | Retains explicit privileged administration, including protected roles and capabilities outside their own effective set. The delegated ceiling/held-role restriction is not a blanket ban on legitimate Owner administration. |
| Authorized duplicate ACTIVE assignment | Existing `409 PERMISSION_ALREADY_ASSIGNED`; one successful grant/audit under concurrent duplicate requests. |

Unknown/inactive role/permission and invalid-ID contracts remain unchanged.
Authorization precedes duplicate detection for a valid ACTIVE target, so an
unauthorized caller receives 403 rather than a duplicate conflict.

The optional actor is preserved **only for existing trusted in-process
bootstrap/fixture callers**. The production HTTP caller always passes the
session actor, and the body parser returns only `permissionId`; an omitted or
forged body actor cannot select the trusted path.

### Scope is not invented

Roles and permission assignments are **installation-global metadata**, not
Client-owned or Building-owned records. There is no role tenant column to
validate. This patch does not invent one or mistake a body `clientId` for scope.
Do not delegate `permission.manage` expecting tenant-local role administration.

Capability grants do not create Building assignments or bypass existing scoped
business guards. A real recipient-session regression grants `building.read` and
`client.read`, then proves: assigned Building/Client reads succeed; unassigned
sibling Building, foreign-Client Building, and foreign Client reads return the
existing scope 403s. The Building-assignment table is unchanged, including when
forged scope fields accompany POST.

## 2. Mutation boundary, audit, and preservation

Grant now runs role/permission reads, live authorization, duplicate detection,
and insertion on **one transaction client**. Its advisory-lock order is:

1. **724196034** — the existing user-role mutation lock, exported from the role
   service instead of duplicating its value. Stabilizes role membership and
   role-assignment classification against the existing role service paths.
2. **724196035** — the existing permission grant/revocation/last-authority lock.
   Stabilizes effective permission grants against revocation and concurrent
   grant changes.

Locks are acquired before authorization reads. The effective-permission
repository now optionally accepts that transaction client; callers that omit
it retain the original pool-backed behavior. Four real lock-wait regressions
commit an authority change after route RBAC but before grant checks: loss of
`permission.manage`, loss of the requested permission, new held-role membership,
and loss of Owner membership. All deny without a target grant or success audit.

The privileged check is shared by grant and revoke under a mutation-neutral
name. **Its revoke logic is unchanged.** DELETE keeps its existing lock,
soft-revoked history, last-authority invariant, response/errors, live session
refresh, and `PERMISSION_REVOKED` event. Role mutation behavior is unchanged;
only its existing lock constant is exported. Last-Owner protection is tested.

Successful grant audit retains actor, server request ID, IP, user agent, and
`{ roleId, roleCode, permissionId, permissionCode }`. It remains after commit,
as before; this PART does not claim audit atomicity. Denied or rolled-back
grants emit no successful `PERMISSION_GRANTED` event.

**Preserved source:** defaults, foundation seed, catalogue, bootstrap, account
lifecycle, sessions/passwords, Client/Building guards, customer consent,
quotation-before-crew, assignment/arrival, QC, payment confirmation, final-close,
and the direct tenant→Handyman payment / BM-fee model are not changed.

## 3. Exact change inventory

| File | Purpose |
|---|---|
| `src/modules/permissions/permission.service.ts` | Transactional grant authorization, delegated ceiling/held-role guard, shared privileged grant/revoke check. |
| `src/modules/permissions/permission.repository.ts` | Optional transaction client for the existing effective-permission resolver. |
| `src/modules/roles/role.service.ts` | Export existing lock constant only; no role-policy change. |
| `tests/permission-grant-authority.test.ts` | 23 new focused, real-PostgreSQL authority/preservation/concurrency cases. |
| `tests/permission-revocation.test.ts` | Preserve eight revoke cases; replace unsafe delegated privileged restoration with denial plus explicitly authorized Owner recovery. |
| `tests/permissions.test.ts` | Use a real Owner for arbitrary-grant contract fixtures; self-contained disposable DB instead of possible external-DB access/skip. Existing 27 cases retained. |
| `docs/api/openapi.yaml` | Existing POST policy, existing 403 codes, permission metadata, and scope clarification; no request/response shape change. |
| `docs/api/CR-HM-BE-IAM-ADMIN-02_FRONTEND_HANDOFF.md` | Matching grant/delegation/denial/recovery guidance for existing consumers. |
| `docs/audits/CR-HM-BE-IAM-E2E-AUDIT-01-PART-02.md` | This delivery report and PART 03 handoff. |

The old last-authority test restored the Owner's `permission.manage` via a
non-Owner holder. That successful POST was the very grant bypass being closed,
not an authorized recovery entitlement. The revised test proves denial, then
uses the still-authorized Owner's existing `role.manage` route to explicitly
appoint a recovery Owner. That Owner restores the grant; cleanup returns to the
original Owner posture. No revoke or last-authority check was weakened.

## 4. Fresh verification

### Environment and commands

Only the six named files below were executed, not the full suite. IAM suites
use disposable embedded PostgreSQL on **127.0.0.1:55580–55582**, database
`asentra_test`; clusters were stopped and removed. Existing repository
migrations initialized those **test-only** schemas, and existing bootstrap/seed
code supplied fixtures. **No new migration, no migration rewrite, and no
external/development/production database access or reseed.**

```bash
NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/permission-grant-authority.test.ts \
  tests/permission-revocation.test.ts \
  tests/permissions.test.ts

NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/openapi-contract.test.ts \
  tests/error-contract.test.ts \
  tests/mobile-openapi-completeness.test.ts

npm run typecheck
git diff --check
```

| Gate | Fresh result |
|---|---|
| New grant authority suite | **23 PASS / 0 FAIL / 0 SKIP**. |
| Existing revocation suite | **8 PASS / 0 FAIL / 0 SKIP**. |
| Existing permission/catalogue/assignment/resolver suite | **27 PASS / 0 FAIL / 0 SKIP**. |
| IAM lane total | **58 PASS / 0 FAIL / 0 SKIP**, eight suites. |
| OpenAPI + shared errors + mobile OpenAPI completeness | **16 PASS / 0 FAIL / 0 SKIP**, four suites. |
| Combined fresh repository tests | **74 PASS / 0 FAIL / 0 SKIP across six selected files**. PART 01 results are not reused as fresh evidence. |
| `npm run typecheck` | **PASS** (`tsc --noEmit`, repository source configuration). |
| Whitespace / scope review | **PASS**; explicit nine-file inventory above, no migration/config/lockfile/default/lifecycle change. |

Intentional failure/rollback probes log their expected 500; lightweight
OpenAPI negative probes can log an uninitialized-database error. These are
passing negative checks, not test failures or observed production outages.
Raw run logs are workspace-only under
`/home/user/.cache/hm-iam-e2e-audit/part02/` (`iam.tap`, `contracts.tap`,
`typecheck.log`), not committed build artifacts.

### Required PASS/FAIL evidence

| Acceptance boundary | Verdict and assertion |
|---|---|
| Authorized administrative grant | **PASS:** Owner 201 with full audit; non-Owner bounded grant 201; additive multi-role delegation 201. |
| Unauthorized actor | **PASS:** unauthenticated 401; authenticated under-privileged 403; unknown/inactive service actor 403; forged identity claims do not authorize. |
| No delegated self-elevation | **PASS:** held administrative and held ordinary roles deny; current effective permissions remain unchanged; cross-role self-consolidation also denies. |
| No beyond-delegation grant | **PASS:** unheld ordinary target + unowned code returns `PERMISSION_DENIED`; live revocation during an in-flight request also denies. |
| Protected roles/codes | **PASS:** all four authority-defining codes, Owner role, and custom authority-granting role deny delegated POST with `PRIVILEGED_ROLE_ASSIGNMENT_DENIED`; Owner positives retained. |
| No scope bypass | **PASS:** assigned Building/Client 200, sibling/foreign Building and foreign Client 403; no Building-assignment mutation. |
| Denials do not mutate role permissions | **PASS:** complete assignment/history table and successful-grant audit snapshots stay identical for denial cases. Race cases isolate the expected concurrent actor-side change and prove no target grant/audit. |
| Atomic failed grant / duplicate replay | **PASS:** injected error after real INSERT rolls back with no grant/audit; concurrent duplicate requests return 201 + 409 and exactly one row/event. |
| Revocation unchanged | **PASS:** eight existing cases retain delegated ordinary revoke, protected denial, repeated 404, last-authority 409/recovery, live sessions/password preservation, audit and validation. |
| Defaults / last Owner / authentication preserved | **PASS:** actual bootstrap Owner **333** = catalogue **365** minus **32** withheld; System/Care/Manager/Ops/Mobile **9/8/29/38/18**, exact source sets and end-of-suite default snapshots match; last Owner removal 409; Owner credential unchanged and session valid. |

Default source SHA-256 values match the pre-patch baseline:

- `src/modules/iam-bootstrap/iam-canonical-roles.ts`:
  `23eb4355bf0a836a70d59e6744aaf2fe824d253f47e45d76026ce7e497256422`
- `src/database/seeds/foundation-access.seed.ts`:
  `d2c6ded53bc890d30b8e7ebd6eea94a4cb144d92c942db9780155219f37074d1`

## 5. Remaining risks and limits

- This is local source/test evidence, **not production or consumer acceptance**.
  Existing excess/deployed grants are not inventoried or automatically revoked.
  No Web/PWA/Android runtime or live provider/configuration check was run.
- Owner is intentionally the installation authority, not a bounded delegate.
  Owner administration and global delegation need operational governance; this
  patch does not create Client-local IAM or a new delegation registry.
- Trusted SQL/bootstrap and actorless in-process calls remain privileged seams.
  All HTTP callers must continue forwarding the authenticated actor. Lock-race
  evidence covers the existing user-role and permission grant/revoke paths,
  not every manual/catalogue/account-lifecycle interleaving or load scenario.
- Audit-after-commit behavior is retained; durable atomic high-risk mutation
  evidence remains a later governance/audit concern (PART 01 P1-04 / proposed
  PART 09), not silently claimed fixed here.
- PART 01 **P0-02 through P0-06** remain: PIC identity-link governance, customer
  consent/recording, readiness clearances, payment maker/checker independence,
  and BM-versus-provider actor authority. Other P1/contract gaps and **BA-08
  through BA-11** live release gates remain. Production stays **NO-GO**.

## 6. Precise PART 03 handoff — recommendation only

**Recommended next instruction:**

> HANDYMAN-BACKEND — PART 03 ONLY — CR-HM-BE-IAM-E2E-AUDIT-01:
> PIC identity-link governance. Continue from the delivered PART 02 HEAD on
> `arena/3a9f4872-handyman-backend`; verify clean state and read both reports.
> Do not open a PR, deploy, or execute further PARTs automatically.

1. Trace `src/modules/tenant-pics/tenant-pic.{routes,validation,service}.ts`,
   specifically generic scoped PATCH accepting `userId`. This links a contact
   to customer decision authority; ordinary contact maintenance is different.
2. Preserve the existing exact-PIC quotation/variation guard in
   `handyman-tenant-decision-authority/handyman-tenant-decision-authority.ts`.
   Do not rebuild decision engines or make Care/Operations the customer.
3. Establish the authorized relink actor/proof/audit/current-request policy
   from source and approved requirements, then apply the narrow Backend guard.
   Preserve legitimate non-identity contact editing and valid authorized
   relinks. Report any strictly necessary schema dependency before proceeding.
4. Add focused self-rebind, unauthorized relink, cross-PIC/company/Client/Building,
   and relink→decision race negatives, plus positive contact-maintenance and
   authorized-relink tests. Verify no denied mutation/decision side effect and
   preserve quotation/variation/current-request semantics and audit evidence.
5. Deliver only that bounded PART, matching API handoff, focused tests/typecheck,
   same-branch commit/push and clean-tree evidence; stop again. Do not implement
   customer BAST/payment consent, readiness, Finance, consumer UI, or other
   lifecycle changes as incidental work.

**Stop after PART 02. No PART 03 code has been changed.**
