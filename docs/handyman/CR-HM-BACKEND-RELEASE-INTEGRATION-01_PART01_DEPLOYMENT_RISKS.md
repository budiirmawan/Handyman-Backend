# CR-HM-BACKEND-RELEASE-INTEGRATION-01 — PART 01
# Deployment Risk Register (Biznet Coolify)

| Severity | Meaning |
| --- | --- |
| **R1** | Blocks release — must be resolved before merge |
| **R2** | Must be handled during the deployment window |
| **R3** | Accept and monitor |

**Current count: R1 = 0 · R2 = 4 · R3 = 6.**

---

## R2 — handle during the deployment window

### R2-1. Eleven migrations must run before traffic is admitted

The artifact contains 11 new migrations; `verifyMigrationReadiness` **fails
closed** when history ≠ artifact. Deploying the image without running
`db:migrate:prod` will refuse traffic rather than serve on a half-migrated
schema.

*Mitigation:* run the one-shot migration as a release step, then confirm
`0461…0468`, `0470…0472` are present and `0469` is not. Verified on a
disposable cluster (14/14).

### R2-2. `0472` repairs the notifications CHECK in place

`0472` drops and re-adds `notifications_navigation_target_check`. On an
environment that already recorded `0472` with the old definition, the guard in
`src/database/migrate.ts` re-runs `0472.up()` inside the migration transaction.

*Mitigation:* the repair is additive (no row deletion), verified by harness
check **D2**. Take a snapshot before migrating anyway; a CHECK re-validation
takes an `ACCESS EXCLUSIVE` lock on `notifications` for its duration.

### R2-3. Existing passwords and the Super User must survive

No migration or seed touches `user_credentials` or users. Harness check **G**
proves password hashes are byte-identical after the upgrade. `0462` only
**adds** three permissions.

*Mitigation:* before deploying, record the count of `users`,
`user_credentials` and `user_role_assignments` and re-check them after. Then
log in once with an existing Super User password as part of the smoke test.

### R2-4. Competency enforcement becomes active on classified Work Orders

Once `0461–0467` are applied, a **Customer Care–origin** Work Order must be
classified before a new assignment, and a MANDATORY requirement will refuse an
unqualified worker with 409.

*Mitigation:* confirm no requirement is seeded as MANDATORY by default (none
is — requirements are opt-in per Client). If Operations has already configured
requirements, verify the affected trades have qualified workers *before* the
deploy, or the assignment will be refused. Unclassified Work Orders from other
domains are unaffected.

---

## R3 — accept and monitor

### R3-1. Two contract suites were red on `main` before this integration

`handyman-scope-assignments-api` (stale PART C namespace guard, broken by the
inspector-assignment path that already shipped on `main`) and both
`openapi-operational-*` suites (census pins superseded by later PARTs) were
reconciled here. The guards were **not** weakened — only the numbers and the
whitelist of separately governed response routes were refreshed. Risk: a future
route added under `/handyman/...assignment...` outside those surfaces will now
fail with a clear message.

### R3-2. `work-order-assignment` legacy suite still skips in CI-like environments

It requires a local PostgreSQL `asentra_test` and skips otherwise (20 skips).
Its coverage is fully superseded by the embedded-PostgreSQL suites that do run.
Risk: silent coverage loss if someone deletes the newer suites.

### R3-3. `mobile-assignment-contract` needs `ASENTRA_USE_EMBEDDED_POSTGRES=true`

Without the flag it fails (not skips) against a missing local database. This is
pre-existing. Any pipeline that runs it must set the flag.

### R3-4. The `GET /tasks/{p}` duplicate is still present

`/tasks/:id` and `/tasks/:taskId` both mount. Pre-existing on `main`, collapses
to one OpenAPI operation, and the parity suites already encode it as the single
expected arithmetic gap. Not introduced here and not fixed here (out of scope).

### R3-5. Competency evaluation cost on assignment

Every assign/reassign now evaluates requirements per subject (ALL for a person
or team, ANY for a vendor) and writes a decision ledger row. Teams with many
active members mean more queries inside the assignment transaction.

*Mitigation:* monitor assignment p95 latency after deploy; team membership is
bounded in practice. The vendor path is `ANY`, so it short-circuits on the first
qualifying worker.

### R3-6. Notification fan-out growth

Assignments now emit `IN_APP` notifications on top of the operational event, and
`0472` adds a dedup index scoped to assignment source types. Watch table growth
on `notifications`; the dedup index keeps replays from multiplying rows.

---

## Rollback posture

* **Application:** roll back the image to the previous release.
* **Database:** there is **no down-migration** in this release, by design.
  `0467.down()` refuses to run while `RECLASSIFIED` rows exist, and the decision
  ledgers are append-only by trigger. Rolling the schema back would destroy
  competency and assignment-response audit history.
* **Therefore:** the rollback plan is *roll forward*, plus a pre-deploy snapshot
  for a full restore if the schema itself must be reverted.

---

## Go / No-Go checklist for FINAL REVIEW

- [ ] Snapshot of the Biznet database taken
- [ ] `npm run typecheck` and `npm run build` green on the merge commit
- [ ] `db:migrate:prod` runs once cleanly (11 rows, no `0469`)
- [ ] Second `db:migrate:prod` reports 0
- [ ] Existing Super User logs in with the existing password
- [ ] Permission revocation observed on the next request
- [ ] One Work Order classified, assigned, TERIMA recorded
- [ ] One TIDAK_BISA recorded and reassigned
- [ ] Arrival QR/GPS verification still returns 200
- [ ] Photo evidence upload + stream still works
- [ ] No 500 in the first 30 minutes (`statusCode>=500` log filter)
