# Handyman Backend — Full-Repo Rebuild, E2E R0/R1A + R1B Persistence Foundation
Date: 2026-10-12

## What this ZIP contains
Full Handyman Backend tree, based on the **user-provided Handyman-Backend-main.zip** (not a live Git branch). All pre-existing files are preserved, with the R1A pure appointment preflight core plus this bounded R1B database/repository addition.

### Added/changed relative to R1A ZIP
1. `src/database/migrations/0431_create_handyman_visit_appointments.ts` — additive schema:
   - `handyman_visit_appointments` (INSPECTION vs EXECUTION, separate visit identity and state, server-consent reference, request/client/building/tenant consistency, immutable slot, versioned transitions).
   - `handyman_visit_capacity_reservations` — `btree_gist` exclusion constraint to prevent overlapping active capacity for the same `(client, resource type, resource ID)`; exact appointment/window matching; reservation cannot be reactivated.
   - Deferred commit guards: CONFIRMED/IN_PROGRESS appointment requires an active reservation; non-active/terminal appointment cannot retain an active reservation.
   - `handyman_visit_attempts` — append-only attempt/evidence log, idempotency per appointment; failed/no-show attempts do not write frozen final inspection results.
2. `src/database/migrations/index.ts` — registers new migration after #0430.
3. `src/modules/handyman-appointment-contract/handyman-appointment.repository.ts` — transaction-bound proposal/read/attempt primitives only; deliberately NO public confirmation endpoint or client-facing write.
4. `tests/handyman-appointment-persistence.test.ts` — focused schema/adapter tests, alongside the 19 original R1A tests.

**Key safety statement:** A migration is not proof of a production-bookable workflow. In particular this delivery **does not include an authenticated tenant-consent verifier**, authoritative inspector/crew eligibility resolver, booking service with actor/permission checks, inspector arrival/permit check-in, public schedule/confirm/reschedule routes, Operations API adapter, or cross-repo E2E. A string field containing an evidence ID is not itself valid consent. Never expose repository methods directly through HTTP.

## How to integrate into the active repo
1. Verify current branch, HEAD, status, remote and migration index. This ZIP is a snapshot, NOT guaranteed to match live Git.
2. Diff the two added source files and migration registry against current branch. Confirm `0431` is unused; if occupied, resolve migration governance before applying (do not renumber blindly).
3. Review Postgres `btree_gist` extension privilege. Migration requires an administrator / grant able to install the extension; do not silently remove exclusion guarantees.
4. Deploy the migration only after a review/backup. Apply with the existing `npm run db:migrate` command in a disposable cloned DB first. No live production DB was changed when building this ZIP.
5. Focused local validation (Node 22+):
   `node --experimental-strip-types --test tests/handyman-appointment-core.test.ts tests/handyman-appointment-persistence.test.ts`
   Snapshot result: **26/26 PASS** (pure/unit/static mocks; not DB integration).
6. After installing project dependencies, run `npm run typecheck`, focused Postgres migrated tests, multi-session concurrency (one reservation wins; other gets SQLSTATE 23P01 mapped to 409), and cross-app acceptance; these remain unverified here.

## Lifecycle alignment
Tenant/Care request → triage → (optional inspection) appointment proposal → tenant verified slot → Ops confirmed resource capacity → permit/access → inspector arrival/attempt(s) → one immutable final inspection result → diagnosis → quotation → tenant decision → separate execution appointment → crew execution → supervisor QC → authorized BAST → invoice → Care reports payment → Finance verifies → Manager CLOSE → warranty/settlement independent.

**Excluded from this limited R1B foundation**: Payment authority, Manager CLOSE, and BAST route fixes (still P0 in consolidated review). Inspection fee/no-show billing rules are unresolved; **no automatic charges**. Frozen historical migrations #1–#430 and all pre-existing services remain untouched.

## Technical scope of the tests
- Pure R1A admission and visit attempt eligibility tests (19 cases).
- Migration DDL invariant presence, proposed-row derivation, request-scoped read, idempotent replay and conflict (7 cases).
- TypeScript parser check on new files PASSED.
- **Not performed**: database-backed migration/rollback, installed-dependency build/typecheck, live API auth/role/tenant tests, device/browser E2E, Git commit/push.
