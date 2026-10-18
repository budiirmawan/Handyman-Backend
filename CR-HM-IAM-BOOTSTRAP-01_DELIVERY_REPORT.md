# CR-HM-IAM-BOOTSTRAP-01 — Delivery Report

**First Owner Account & User Management**

Status: implementation complete, hardening pass applied and tested locally,
**not merged, not deployed, not executed against production**.

- Branch: `arena/95af75ae-handyman-backend`
- Base: `0b72d7c5bff5f978740f17191821c4b26351a25d` (`main`)
- Commit: `8101b2d90dc213c296cd3e1439ea5ca6f5b8dda1`
- Pull request: https://github.com/budiirmawan/Handyman-Backend/pull/40 (not merged)

---

## 1. P0 — Existing IAM audit (what was actually there)

### 1.1 Reused capabilities (no duplicate implementation)

| Capability | Implementation reused |
|---|---|
| Identity | `src/modules/users/*` — `users` table, normalized email, status `INVITED/ACTIVE/INACTIVE/SUSPENDED` |
| Credentials | `src/modules/auth/credential.*` — `user_credentials`, one row per user, bcrypt cost **12**, policy 8–72 chars, `must_change_password` column |
| Password hashing | `passwordService.hashPassword/verifyPassword` (`src/modules/auth/password.service.ts`) — no new hasher |
| Sessions | `src/modules/auth/session.*` — opaque SHA-256-hashed tokens, ACTIVE/REVOKED, account-state revalidation |
| Roles | `src/modules/roles/*` — `roles`, `user_role_assignments` (partial unique index on ACTIVE), assign/list services |
| Permissions | `src/modules/permissions/*` — `permissions`, `role_permission_assignments`, `resolvePermissionsForUser` (the same resolver `requirePermission` uses) |
| RBAC enforcement | `requirePermission` (`src/modules/auth/rbac.middleware.ts`) — default deny |
| Invitations | `src/modules/invitations/*` — PENDING/ACCEPTED/REVOKED, SHA-256 token hash, single-use, transactional acceptance creates user + credential |
| Effective context | `GET /auth/me` via `effective-context.service.ts` — roles, permissions, reachable Client/Property/Building, scope, entitlements |
| Account lifecycle | `user-lifecycle.service.ts` — activate/deactivate/suspend/reactivate with session revocation + audit |
| Audit | `authentication_audit_events` + `recordEvent` (best-effort) and `GET /auth/audit-events` (`auth.audit.read`) |
| Tenant/Building isolation | BE-02G resolvers; unchanged |
| Migration runner | `src/database/cli.ts` + `migrate` / `status` / advisory lock / readiness checks |
| Seed | `foundation-access.seed.ts` — authoritative permission catalogue + `PLATFORM_ADMIN`; explicitly creates **no** user/credential/password |

### 1.2 What was missing (the actual gap)

1. **No first-admin bootstrap of any kind.** `grep -i bootstrap` found only
   seed comments, test helpers and unrelated business “prospect bootstrap”.
   The database CLI accepted only `migrate|status|down|seed`; no HTTP
   bootstrap route existed (and none was added).
2. **Production `roles` was 0 rows**, so `PLATFORM_ADMIN` did not exist; the
   foundation seed had not been run (or had been rolled back).
3. **No canonical persona roles** for Customer Care, Operations, Manager,
   System Admin or Mobile Staff. Only `PLATFORM_ADMIN` was seeded.
4. **No user listing.** Only `GET /users/:id`; an Owner could not find an
   account by email after invitation acceptance.
5. **No role revocation.** Roles could be assigned but never removed.
6. **No administrative password reset** and **no self-service password
   change** endpoint. `must_change_password` existed but was never set by an
   API and never cleared.
7. **No one-time guard** preventing a later operator from minting another
   privileged account, and no proof-of-bootstrap row.
8. **No Owner-target takeover guard** on `user.manage`: a lesser admin could
   have reset the Owner's password.

### 1.3 Authoritative authority verification

- `FOUNDATION_PERMISSIONS` (seed) and the additive migration registrations
  are the only permission catalogue. All 64 candidate codes used by the new
  role matrix were checked against `src/database/seeds` +
  `src/database/migrations`; every code already exists.
- `requirePermission` resolves codes from the database, never from a role
  name. Assigning a role name alone grants nothing.
- Withheld codes (`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`) were kept
  withheld from the Owner: finance execution/settlement, QC, BAST issuance,
  Care-Building authority, budget override, RFQ award, price override, FX
  approval and the whole `platform.*` namespace.
- No new permission code was invented. Migration 0452 only extends the audit
  event vocabulary and adds the bootstrap proof table.

---

## 2. P1 — Implemented first-Owner bootstrap

### 2.1 Command surface (operator only, no HTTP)

```bash
node dist/database/cli.js bootstrap-status
node dist/database/cli.js bootstrap-owner --email <email> --display-name <name>
```

- Docker image already ships `dist/database/cli.js`; no new entrypoint.
- No public bootstrap route was registered anywhere in `src/routes`.
- `--password` is rejected **before** configuration/connection.
- Password is read from `/dev/tty` in raw mode (no echo, no pipe, no env).
  If there is no controlling terminal the command fails closed.
- Password policy and bcrypt(12) come from the existing
  `passwordService.hashPassword`; nothing is reimplemented.
- Successful output contains ids/codes only; no password/hash/token.

### 2.2 Transaction & refusal design

One database transaction contains:

1. advisory xact lock `724196032` (distinct from the migration lock),
2. `iam_bootstrap_state` schema check,
3. singleton completion check,
4. `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` + `count(users) = 0`,
5. privileged-assignment check,
6. foundation catalogue seed (`seedFoundationAccess`, idempotent),
7. permission-existence verification (fails on any missing code),
8. five canonical persona roles + exact grants,
9. Owner user + bcrypt credential + `PLATFORM_ADMIN` assignment,
10. singleton proof row `iam_bootstrap_state`,
11. `OWNER_BOOTSTRAPPED` audit event.

Any failure rolls all of it back. A repeat run is refused by the proof row
and independently by the non-empty users / privileged-assignment checks.

### 2.3 Migration 0452 (additive)

- Creates `iam_bootstrap_state` (singleton CHECK `id = 'OWNER_BOOTSTRAP'`,
  FK to `users`, `role_codes`, metadata).
- Extends the `authentication_audit_events.event_type` CHECK with
  `OWNER_BOOTSTRAPPED`, `PASSWORD_RESET`, `PASSWORD_CHANGED`.
- No table is dropped, no column is rewritten, no existing event type is
  removed. Rollback drops only the new table and restores the previous CHECK.

### 2.4 Safety properties verified by tests

- Empty database required; existing user ⇒ refusal, no role creation.
- Policy-violating password ⇒ refusal, zero writes.
- Injected failure at the final insert ⇒ **zero** rows in users, credentials,
  roles, permissions, assignments, audit and state.
- Successful bootstrap ⇒ exactly one user, bcrypt hash verifies, exactly one
  `PLATFORM_ADMIN` assignment, five persona roles, no Building assignment.
- Second bootstrap ⇒ `IAM_BOOTSTRAP_ALREADY_COMPLETED`, user count stays 1.
- Audit metadata and CLI result never contain the password.

---

## 3. P2 — Multi-persona authorization

Implemented on top of the existing mechanisms:

| Need | Capability |
|---|---|
| Find accounts | `GET /users` (`user.read`) — exact email/status filters, bounded pagination (`page`, `pageSize` ≤ 200), `meta.total` |
| Assign role | existing `POST /users/{userId}/roles` (`role.manage`) |
| Revoke role | **new** `DELETE /users/{userId}/roles/{roleId}` (`role.manage`); 404 if not active; 409 `LAST_OWNER_ROLE_REQUIRED` for the last Owner |
| Organizational scope | existing `POST/DELETE /users/{userId}/buildings` (`building.manage`) — no change |
| Invite | existing `POST /invitations` + public `POST /invitations/accept` |
| Activate/suspend | existing `deactivate` / `suspend` / `reactivate` (`user.manage`) |
| Password reset | **new** `POST /users/{id}/password-reset` (`user.manage`) — revokes all sessions before writing the hash, sets `must_change_password`, no secret returned |
| Self password change | **new** `POST /auth/password` (authenticated) — verifies current password, revokes all OTHER sessions, clears `must_change_password` |
| Read plaintext password | impossible — not stored; no API returns credential rows/hashes |
| Owner takeover guard | non-owner reset of a `PLATFORM_ADMIN` account → 403 `PRIVILEGED_ACCOUNT_RESET_DENIED` |

Every user still has their own `user_credentials` row. No shared or default
account exists.

Role/permission details: see
`CR-HM-IAM-BOOTSTRAP-01_ROLE_PERMISSION_MATRIX.md`.

---

## 3A. Production security hardening (second pass)

| Issue found | Fix | Enforcement point |
|---|---|---|
| `SYSTEM_ADMIN` (or any `user.manage` holder) could suspend/deactivate the Owner — denial of service and lockout | Owner targets are **protected**: only an actor holding `PLATFORM_ADMIN` may transition or change the contact of an owner account | `user-lifecycle.service.transition`, `user.service.updateUserWhatsAppContact`, `privileged-account.guard.ts` |
| Owner could suspend their own account, revoking the session used to do it (and `SUSPENDED` has no reactivation path) | Self-transitions denied with `403 SELF_ACCOUNT_ACTION_DENIED` | `user-lifecycle.service.transition` |
| No last-owner guard on account status | Last **usable** owner (ACTIVE account + ACTIVE assignment) cannot be deactivated/suspended → `409 LAST_OWNER_ACCOUNT_PROTECTED`, checked under `pg_advisory_xact_lock(724196033)` | `user-lifecycle.service.transition` |
| A delegated `role.manage` holder could assign `PLATFORM_ADMIN` | Assignment/revocation of any authority-defining role (owner role or grants `role.manage`/`permission.manage`) requires an owner actor → `403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED` | `role.service.assertPrivilegedRoleMutationAuthorized` |
| An owner's WhatsApp notification channel was editable with `user.manage` alone | Same protected-account rule on `PATCH /users/{id}/whatsapp-contact` | `user.service` |
| `must_change_password` was stored but never enforced | Enforced in the authentication middleware on every request; only password change, status, logout and `/auth/me` remain reachable → `403 PASSWORD_CHANGE_REQUIRED` | `password-change.middleware.ts`, `session.service.resolveSessionContext` |
| No contract to read the forced-change state (`/auth/me` shape is frozen) | New `GET /auth/password/status` → `{ mustChangePassword }` | `auth.routes`, OpenAPI |
| `CUSTOMER_CARE` inherited `tenant_company.manage`, reaching dispatch release, BAST customer acceptance, payment recording, triage and material purchasing | Removed the coarse grant from the canonical role (smallest correction, no invented permission); care keeps `handyman.care.building` + `service_request.manage` + reads | `iam-canonical-roles.ts`, verified for 7 mutation routes |
| Runbook assumed `railway ssh` always provides a TTY and that one DB role runs migrations and the app | Runbook now documents PTY autodetection, a mandatory `/dev/tty` preflight, tmux and `script` fallbacks, separate migration vs `hm_app` roles, and a backup + schema verification gate | `CR-HM-IAM-BOOTSTRAP-01_OPERATOR_RUNBOOK.md` §2–§6, §13 |

No second session mechanism, no relaxed session invalidation and no new
superuser were introduced. The one-time bootstrap transaction is unchanged.

---

## 4. Files changed

### New

| File | Purpose |
|---|---|
| `src/database/migrations/0452_create_iam_owner_bootstrap_state.ts` | Singleton proof table + audit vocabulary |
| `src/modules/iam-bootstrap/iam-canonical-roles.ts` | Canonical persona definitions + authoritative grants |
| `src/modules/iam-bootstrap/owner-bootstrap.service.ts` | Transactional bootstrap + status |
| `src/modules/iam-bootstrap/owner-bootstrap.cli.ts` | Strict argv parser, `--password` refusal |
| `src/modules/iam-bootstrap/password-prompt.ts` | `/dev/tty` raw-mode no-echo input |
| `src/modules/iam-bootstrap/index.ts` | Operator-only exports |
| `src/modules/users/privileged-account.guard.ts` | Owner/self-account authorization guard |
| `src/modules/auth/password-change.middleware.ts` | Forced-change allowlist + enforcement |
| `tests/iam-bootstrap.test.ts` | 22 focused tests (19 cases + 2 suites) |
| `CR-HM-IAM-BOOTSTRAP-01_MULTI_PERSONA_CONTRACT.md` | Owner multi-application + separation-of-duties contract |
| `CR-HM-IAM-BOOTSTRAP-01_OPERATOR_RUNBOOK.md` | Termux + Railway procedure |
| `CR-HM-IAM-BOOTSTRAP-01_ROLE_PERMISSION_MATRIX.md` | Role/permission matrix |
| `CR-HM-IAM-BOOTSTRAP-01_DELIVERY_REPORT.md` | This report |

### Modified

| Area | Files |
|---|---|
| Migration registry | `src/database/migrations/index.ts` |
| Seed reuse | `src/database/seeds/foundation-access.seed.ts` (`seedFoundationAccess(client)` extracted; standalone behavior unchanged) |
| CLI | `src/database/cli.ts` (commands, `initDatabase` for repository access, status/summary output) |
| Audit | `src/modules/audit/audit.types.ts`, `audit.repository.ts` (client-aware insert) |
| Auth | `auth.service.ts`, `auth.controller.ts`, `auth.routes.ts`, `auth.validation.ts`, `auth/index.ts`, `credential.service.ts`, `credential.repository.ts`, `credential.types.ts`, `session.service.ts`, `session.repository.ts` |
| Users | `user.repository.ts`, `user.service.ts`, `user.validation.ts`, `user.controller.ts`, `user.routes.ts`, `user-lifecycle.service.ts`, `user.errors.ts`, `index.ts` |
| Roles | `role.repository.ts`, `role.service.ts`, `role.controller.ts`, `role.routes.ts`, `role.errors.ts`, `index.ts` |
| Errors | `src/shared/errors.ts` (9 new codes total; 5 added by the hardening pass) |
| Hardening | `user-lifecycle.service.ts`, `user.service.ts`, `user.controller.ts`, `user.repository.ts`, `role.service.ts`, `role.controller.ts`, `role.repository.ts`, `session.service.ts`, `session.types.ts`, `authentication.middleware.ts`, `auth.service.ts`, `auth.controller.ts`, `auth.routes.ts`, `auth.errors.ts`, `user.errors.ts`, `role.errors.ts`, `iam-canonical-roles.ts` |
| Contract | `docs/api/openapi.yaml` (GET /users, password-reset, DELETE role, POST /auth/password, GET /auth/password/status) |
| Scripts | `package.json` (`db:bootstrap-*`) |
| Tests | `tests/deployment-cors-production.test.ts`, `tests/deployment-portability.test.ts` (canonical registry 451 / latest 0452); `tests/mobile-auth-contract.test.ts` (`/auth/*` path lock now includes `POST /auth/password`) |

---

## 5. Focused verification results

Executed locally against embedded PostgreSQL 18.4:

```bash
ASENTRA_USE_EMBEDDED_POSTGRES=true NODE_ENV=test LOG_LEVEL=error \
  npx tsx --test --test-concurrency=1 tests/iam-bootstrap.test.ts
```

Result: **22 pass, 0 fail, 0 skipped** (19 test cases, 2 suites).

Coverage:

1. `--password` argument refusal.
2. Missing/unknown argument refusal.
3. Identity-flag parsing.
4. Fresh status (`schemaReady`, 0 users, not completed).
5. Policy-violating password → no writes.
6. Non-empty users → refusal, no role creation.
7. Injected final-step failure → full rollback of 8 tables.
8. One Owner, bcrypt hash (cost 12), one `PLATFORM_ADMIN`, five persona
   roles, zero Building assignments, no secret in result/audit.
9. Repeat bootstrap refusal (user count stays 1).
10. Owner login + `/auth/me` includes IAM permissions; all withheld
    authorities absent.
11. `GET /users` bounded listing + exact email filter, no credential fields.
12. Every canonical role grants exactly its documented permission set;
    `SYSTEM_ADMIN` lacks `role.manage`/`permission.manage`; `MOBILE_STAFF`
    lacks `tenant_company.manage`/`user.manage`.
13. Customer Care onboarding: invitation → acceptance → role assignment;
    care capabilities present; user list/create/permission-grant/owner-reset
    all `403`.
14. Admin reset: all sessions `401`, old password rejected,
    `must_change_password=true`; self change verifies current password,
    keeps caller session, revokes other sessions, clears the flag.
15. Role revocation works; repeated revoke `404`; last Owner revoke `409`.
16. System Admin cannot reset the Owner (`403
    PRIVILEGED_ACCOUNT_RESET_DENIED`) or assign `PLATFORM_ADMIN`/create roles
    (`403`), but can list users (`200`).
17. Completed status + exactly one active `PLATFORM_ADMIN`.
18. Mandatory password change: `GET /auth/password/status` reports `true`;
    `/auth/me` and logout stay reachable; `GET /users` and a lifecycle
    mutation return `403 PASSWORD_CHANGE_REQUIRED`; a wrong current password
    is `401`; a successful change clears the flag and reopens the surface.
19. System Admin cannot suspend, deactivate or change the WhatsApp contact of
    the Owner (`403 PRIVILEGED_ACCOUNT_PROTECTED`) while ordinary accounts
    still transition normally.
20. Owner self-suspend/self-deactivate → `403 SELF_ACCOUNT_ACTION_DENIED`
    and the account remains ACTIVE.
21. A delegated role carrying `role.manage` still cannot assign
    `PLATFORM_ADMIN` (`403 PRIVILEGED_ROLE_ASSIGNMENT_DENIED`); the owner set
    is unchanged.
22. Customer Care is denied dispatch release/cancel, BAST accept/sign-off,
    customer-payment record/confirm and lifecycle triage (all
    `403 PERMISSION_DENIED`), and holds no `tenant_company.manage`.

Static/build:

```bash
npx tsc --noEmit   # PASS
npm run build      # PASS
```

Compiled-CLI smoke (embedded PostgreSQL, no TTY):

```bash
node dist/database/cli.js migrate          # applied 451 migrations incl. 0452
node dist/database/cli.js bootstrap-status # schema ready, 0 users, not completed
node dist/database/cli.js bootstrap-owner --email ... --display-name ... --password ...
# exit 1: "Passwords must never be supplied as command-line arguments..."
node dist/database/cli.js bootstrap-owner --email ... --display-name ...
# exit 1: "No interactive terminal is available..." (no database writes)
```

Additional focused suites (regression locks touched by this change):

```bash
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 \
  tests/deployment-portability.test.ts tests/openapi-contract.test.ts \
  tests/mobile-auth-contract.test.ts tests/openapi-saas-route-parity.test.ts
```

| Suite | Result | Notes |
|---|---|---|
| `deployment-portability` | **9 / 9 pass** | verifies 451 canonical migrations, latest `0452_create_iam_owner_bootstrap_state`, migration locking and rollback |
| `openapi-contract` | **6 / 6 pass** | every documented endpoint exists in the runtime router (exercises the 4 new operations) |
| `mobile-auth-contract` | **18 / 18 pass** | `/auth/*` path lock updated to include `POST /auth/password`; no refresh route or token field added |
| `openapi-saas-route-parity` | **14 / 15 pass** | the single failure (`no broken local $ref`) is **pre-existing at base `0b72d7c`** and unrelated to IAM — see blocker 13 |

Additional suites re-run for the hardening pass:

| Suite | Result | What it protects |
|---|---|---|
| `handyman-care-building-authority` | **16 / 16 pass** | `handyman.care.building` still works, Building scope still enforced, suspended accounts still `401` |
| `deployment-portability` | **9 / 9 pass** | 451 canonical migrations, latest `0452_`, lock and rollback behaviour |
| `openapi-contract` | **6 / 6 pass** | the new `/auth/password/status` operation exists in the runtime router |
| `mobile-auth-contract` | **18 / 18 pass** | `/auth/*` path lock includes the status endpoint; no refresh or token leakage |

Not run (deliberately): full repository test suite, production bootstrap,
Railway mutation, credential changes.

---

## 6. Exact first-Owner provisioning procedure (summary)

Full step-by-step with Railway/Termux commands:
`CR-HM-IAM-BOOTSTRAP-01_OPERATOR_RUNBOOK.md`.

1. Deploy the merged image containing migration 0452 (release step, not part
   of this CR's Arena work).
2. Termux: `pkg install nodejs-lts jq curl openssh && npm i -g @railway/cli`,
   then `railway login --browserless`.
3. `railway link` → production project/environment/backend service;
   `railway status`.
4. `railway ssh` into the running backend container (or Railway dashboard
   web shell if SSH is unavailable). Do **not** expose PostgreSQL publicly.
5. Verify identity: `printenv RAILWAY_PROJECT_NAME RAILWAY_ENVIRONMENT_NAME
   RAILWAY_SERVICE_NAME` and `node dist/database/cli.js bootstrap-status`
   (host/port/database, 0 users, schema ready).
6. Ensure the runtime DB role has CONNECT/USAGE + DML on the IAM tables
   (runbook §4); DDL only for the migration step.
7. `node dist/database/cli.js migrate` → applies 0452.
8. `node dist/database/cli.js bootstrap-owner --email <email>
   --display-name <name>`; enter/confirm the password at the hidden prompt.
9. `node dist/database/cli.js bootstrap-status` → completed, one owner.
10. Login and `GET /auth/me`; assert `PLATFORM_ADMIN`, `user.manage`,
    `role.manage`, `permission.manage`, `auth.audit.read`, and the withheld
    checks (runbook §7).
11. Invite a Customer Care user, accept, assign `CUSTOMER_CARE`, scope the
    exact Building(s), verify `/auth/me` (runbook §8).
12. Run the four escalation-denial checks (all `403`) and confirm a repeated
    bootstrap is refused (runbook §9).

---

## 7. Frontend user-management gaps

The backend now supports the flows; the frontend does not yet expose them.

1. **User management screen** — list/search users, show status, last update,
   roles and Building scope; use `GET /users?email=&status=&page=&pageSize=`.
2. **Invitation workflow** — create invitation, display/copy the one-time
   token securely, show expiry, revoke; handle `invitationToken` being
   returned exactly once.
3. **Role management** — assign existing roles, revoke role assignments, show
   effective permission summary; surface `409 LAST_OWNER_ROLE_REQUIRED` and
   `404 ROLE_ASSIGNMENT_NOT_FOUND`.
4. **Building scope** — assign/remove Building scope and display it next to
   the role; make clear that a role without scope grants no data.
5. **Password reset UI** — owner-initiated reset, display
   `mustChangePassword`, and a self-service change-password screen calling
   `POST /auth/password`.
6. **Forced change on login** — `/auth/me` deliberately keeps its existing
   exact shape, so `must_change_password` is not yet surfaced to clients. The
   frontend cannot currently know that a reset password must be changed; a
   follow-up contract change is required (see blockers).
7. **Escalation error handling** — map
   `PRIVILEGED_ACCOUNT_RESET_DENIED`, `LAST_OWNER_ROLE_REQUIRED`, and
   `ROLE_ASSIGNMENT_NOT_FOUND` to clear operator messages.
8. **Audit viewer** — render the three new event types (`OWNER_BOOTSTRAPPED`,
   `PASSWORD_RESET`, `PASSWORD_CHANGED`).
9. **No plaintext password UI** — the product must never imply that an
   existing password can be viewed or recovered.

---

## 8. Production release blockers

| # | Blocker | Owner / action |
|---|---|---|
| 1 | PR not merged and image not deployed | Merge after review; deploy Railway backend |
| 2 | Migration 0452 not applied to production | Run `migrate` from the container shell; verify readiness |
| 3 | Owner bootstrap not executed | Execute runbook §6–§9 (human operator, TTY) |
| 4 | ~~`must_change_password` not enforced~~ **RESOLVED** — enforced in authentication middleware; state served by `GET /auth/password/status` (`/auth/me` stays frozen) | Frontend must call the status endpoint after login (multi-persona contract §6) |
| 5 | No automated delivery of invitation tokens or reset notices (`EMAIL_PROVIDER=noop`, no WhatsApp template) | Operator hands tokens over out-of-band until messaging is implemented |
| 6 | Railway plan/CLI SSH/PTY support is **not verified against the live plan from Arena** | Run runbook §3.1 preflight (`TTY_OK`) before any write; the dashboard web shell is the fallback |
| 7 | ~~Customer Care reaches dispatch release via `tenant_company.manage`~~ **RESOLVED for CUSTOMER_CARE** — the coarse grant was removed and 7 mutation routes are test-verified as `403`. **Residual:** `OPERATIONS` and `PLATFORM_ADMIN` still reach dispatch/tenant-transport through the same coarse code | A dedicated dispatch permission is still the long-term fix; keep operational accounts to explicit persona roles |
| 8 | ~~SYSTEM_ADMIN can suspend/deactivate the Owner~~ **RESOLVED** — protected-account, self-action and last-usable-owner guards are enforced transactionally | None for this path; see the MFA and second-Owner items below |
| 9 | No MFA for the Owner; single in-memory login throttle per instance | Security hardening roadmap |
| 10 | Release evidence docs still cite “450 migrations, latest 0451” | Update deployment/go-no-go evidence after 0452 is applied |
| 11 | No second Owner by default | After bootstrap, assign `PLATFORM_ADMIN` to a second trusted person so Owner recovery does not depend on one account |
| 12 | Restore, not rerun, is the only undo for a completed bootstrap | Confirm backup/restore rehearsal before the window |
| 14 | Frontend has no screens for user listing, role assignment, forced password change or the new denial codes | Ship the UI changes described in the multi-persona contract §6–§7; the API is ready |
| 15 | A `SUSPENDED` account has **no API path back to ACTIVE** (`reactivate` accepts `INACTIVE` only), so suspension is effectively permanent for ordinary users | Keep suspension for security cases only; a return to service needs a controlled, audited DBA update or a follow-up CR. Owner/self-suspension is now blocked, so this cannot lock out the installation |
| 13 | **Pre-existing** OpenAPI defect: 3 `$ref`s in `HandymanStatusVisibilityReadView` examples do not resolve (`.../stages/properties/assignment`, `.../stages/properties/readiness`, `.../slaMilestones`) | Unrelated to IAM; fails `openapi-saas-route-parity` identically at base `0b72d7c`. Fix in the owning CR before claiming a fully green OpenAPI suite |

---

## 9. Readiness verdict

**READY for a controlled first-Owner bootstrap**, after the merge and deploy
of this PR and with all of the following true:

1. migration `0452` applied with the migration role (not `hm_app`),
2. `bootstrap-status` shows `Schema ready: yes`, `Users in database: 0`,
   `Bootstrap completed: no`,
3. the `/dev/tty` preflight (`TTY_OK`) passes in the shell used for the
   bootstrap,
4. a recent PostgreSQL backup exists and the restore path is known.

**NOT READY** for unattended/continuous operation until the residual risks are
accepted or closed: no MFA, no second Owner, no automated invitation/reset
delivery, no frontend screens, and the coarse `tenant_company.manage` gate for
`OPERATIONS`/`PLATFORM_ADMIN`.
