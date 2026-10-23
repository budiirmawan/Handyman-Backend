# CR-HM-BACKEND-RELEASE-INTEGRATION-01 — PART 01
# Migration Reconciliation

**Scope:** migrations `0461–0468` and `0470–0472`, verified on a **disposable**
PostgreSQL 18 cluster. No production/Biznet database was read or written.

**Harness:** `tests/manual/release-integration-migration-check.ts`
**Result: 14/14 checks PASS on PostgreSQL 18.4.**

```bash
npx tsx tests/manual/release-integration-migration-check.ts
```

---

## 1. Registered set

| Migration | Source | Purpose |
| --- | --- | --- |
| `0461_create_workforce_certifications` | PR #55 | Individual worker certificates (+ decisions, scope guard) |
| `0462_workforce_certification_permissions` | PR #55 | `workforce_certification.read/manage/verify` |
| `0463_service_catalog_competency_requirements` | PR #55 | Requirements per Service Catalog job type |
| `0464_workforce_competency_decision_history` | PR #55 | Crew-level decision ledger (`handyman_assignment_competency_evaluations`) |
| `0465_work_order_multitrade_classification` | PR #55 | Multi-trade registry + WO classification + WO decision ledger |
| `0466_direct_handyman_workforce` | PR #55 | `provider_type VENDOR/DIRECT`, nullable `vendor_id`, `FREELANCE` |
| `0467_work_order_reclassification_decision` | PR #55 | Adds `RECLASSIFIED` to the decision action vocabulary |
| `0468_extend_permission_grant_audit_events` | IAM | `PERMISSION_REVOKED` audit events |
| `0469` | — | **DOES NOT EXIST — deliberately not created** |
| `0470_handyman_field_expense_reimbursement` | PR #56 | Receipt checksum, finance reimbursement columns + gates |
| `0471_handyman_helper_attendance_confirmation` | PR #56 | Helper roster confirmation + personnel changes |
| `0472_handyman_assignment_responses` | PR #56 | Assignment response ledger + navigation targets + append-only trigger |

Registered migration count in `src/database/migrations/index.ts`: **470**.
Duplicate ids: **0**. Registered order equals numeric order.

---

## 2. Verification matrix

| # | Check | Assertion | Result |
| --- | --- | --- | --- |
| A | Fresh migrate | 470 applied, tip = `0472` | **PASS** |
| A2 | History equals registered set | 470 = 470, `0469` absent | **PASS** |
| B | Re-run immediately after | 0 migrations re-applied | **PASS** |
| B2 | History rows unchanged | rows stable | **PASS** |
| C0 | Release objects exist | 18 tables/columns/indexes/constraints | **PASS** |
| C1 | 0465 baseline seeded | 11 trade categories | **PASS** |
| D | 0472 ledger marker | `notifications_navigation_target_check` contains `EXECUTION_SCOPE_FIELD_WORK` | **PASS** |
| D2 | 0472 stale-CHECK repair | old 0358 CHECK restored → re-run repairs it, 0 migrations re-applied | **PASS** |
| E | Production representation | 459 migrations to `0460` | **PASS** |
| F | Upgrade | 11 migrations (`0461–0468`, `0470–0472`) applied | **PASS** |
| G | Historical data | users 1→1, roles 2→2, user_role_assignments 1→1, password hashes byte-identical | **PASS** |
| H | Provider context default | pre-existing rows read `VENDOR` | **PASS** |
| I | Re-run after upgrade | 0 migrations re-applied | **PASS** |
| J | Historical data after upgrade + re-run | unchanged | **PASS** |

### Objects verified in C0

**Tables** — `workforce_certifications`, `workforce_certification_decisions`,
`handyman_assignment_competency_evaluations`,
`service_catalog_competency_requirements`, `work_order_trade_categories`,
`work_order_assignment_competency_decisions`,
`handyman_helper_attendance_confirmations`, `handyman_assignment_responses`.

**Columns** — `handyman_material_purchase_records.receipt_sha256_checksum`,
`handyman_material_purchase_records.reimbursement_disbursed_at`,
`handyman_provider_contexts.provider_type`, `work_orders.trade_category_id`.

**Indexes** — `work_order_active_assignment_unique`,
`handyman_provider_contexts_direct_client_unique`,
`workforce_certifications_active_unique`.

**Constraints** — `handyman_provider_contexts_type_check`,
`notifications_navigation_target_check`,
`work_order_assignment_competency_decisions_action_check` (contains
`RECLASSIFIED`).

---

## 3. Simulation of the Biznet upgrade (not the real database)

The harness **never connects to Biznet**. It rebuilds a stand-in:

1. Apply every migration up to and including `0460_handyman_settlement_dispute_adjudication`
   → 459 migrations, exactly the schema the current production release runs.
2. Insert historical production-shaped data: a `PLATFORM_ADMIN` role, an
   `OPERATIONS` role, one user, one `user_credentials` row with a bcrypt hash,
   and one `user_role_assignments` row.
3. Snapshot: user/role/grant/permission counts **and** every
   `user_credentials.password_hash`.
4. Apply `migrateUp()` — the production entry point — on top.
5. Compare snapshots.

Outcome: 11 migrations applied; password hashes **byte-identical**; role and
grant counts unchanged; `permissions` grew 15 → 18 because `0462` legitimately
seeds the three certification codes (additive only).

---

## 4. `0472` ledger / correction mechanism audit

`0472` rewrites `notifications_navigation_target_check` **in place**:

```sql
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_navigation_target_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_navigation_target_check CHECK (
  (navigation_target_type IS NULL AND navigation_target_id IS NULL)
  OR (navigation_target_type IN (
        'WORK_ORDER_FIELD_WORK','EXECUTION_SCOPE_FIELD_WORK','INSPECTOR_VISIT_FIELD_WORK')
      AND navigation_target_id IS NOT NULL)
);
```

It widens the vocabulary from one value (`WORK_ORDER_FIELD_WORK`, 0358) to
three, and adds `notifications_assignment_response_dedup_idx` plus the
append-only trigger on `handyman_assignment_response_events`.

### The idempotent upgrade guard in `src/database/migrate.ts`

Because `0472` was already applied on an environment whose CHECK is the **old**
definition, `migrateUp` contains a targeted repair: when the history already
records `0472` but `pg_get_constraintdef` does **not** mention
`EXECUTION_SCOPE_FIELD_WORK`, it re-runs `0472.up()` — inside the same
transaction — instead of skipping.

Verified twice:

* **D** — on a fresh cluster the CHECK already contains the new value → guard
  does not fire.
* **D2** — the CHECK is deliberately downgraded to the 0358 definition, then
  `migrateUp` is called: **0** migrations reported as applied (history
  untouched) **and** the CHECK is repaired. The repair is *additive*: it drops
  and re-adds one CHECK constraint, and never deletes notification rows.

### Rollback safety

No destructive rollback is performed or required. `0467.down()` explicitly
**refuses** to roll back while `RECLASSIFIED` rows exist rather than deleting
competency history, and the ledger tables are append-only by trigger. The
release therefore ships with no down-migration step; the correct recovery path
is a forward fix.

---

## 5. Deployment migration procedure (for FINAL REVIEW)

1. Take a database snapshot/backup of Biznet.
2. Deploy the new image without admitting traffic
   (`verifyMigrationReadiness` refuses to serve if history ≠ artifact).
3. Run the one-shot `db:migrate:prod`.
4. Expect exactly **11** rows added to `schema_migrations`
   (`0461…0468`, `0470…0472`); `0469` must remain absent.
5. A second `db:migrate:prod` must report **0** new migrations.
6. Then admit traffic.

`verifyMigrationReadiness` fails closed if the artifact contains a migration the
database has not applied, **and** if the database records one the artifact does
not contain — so a missing or extra `0469` is caught before traffic.
