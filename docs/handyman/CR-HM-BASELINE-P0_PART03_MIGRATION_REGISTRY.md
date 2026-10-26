# CR-HM-BASELINE-P0 — PART 03: Migration Registry Documentation

- **Recorded:** 2026-10-26
- **Audited artifact:** `arena/131383a6-handyman-backend` at `a3d3036124d72c6be6f84d91a1add40c2df87676`
- **Scope:** current registry inventory and operator guidance only. No migration was changed or executed, and no database was accessed.

This is the current registry note for this baseline. The historical snapshot at [`docs/contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_SCHEMA_FREEZE_CANDIDATE.md`](../contract-freeze/CR-HM-FINAL-BACKEND-CONTRACT-FREEZE-01_SCHEMA_FREEZE_CANDIDATE.md) is intentionally preserved unchanged as a point-in-time record of the earlier `0460` freeze candidate; this note does not rewrite or retroactively amend it.

## Current registry state

The execution registry is the exported `migrations` array in `src/database/migrations/index.ts` (not the textual order of its import statements). At the audited artifact it contains **481 unique migrations**, every registered ID has a matching migration file and in-file `id`, and the array is numerically ordered. The current head is:

```text
0483_handyman_care_initial_scheduling_preference
```

The relevant ordered tail is:

```text
0470_handyman_field_expense_reimbursement
0471_handyman_helper_attendance_confirmation
0472_handyman_assignment_responses
0473_create_browser_push_subscriptions
0474_widen_notification_template_channels_for_push
0475_create_notification_browser_push_deliveries
0476_handyman_assignment_response_client_keys
0477_handyman_parameterized_service_catalog
0478_service_price_tier_key
0479_handyman_service_variant_attribute_lifecycle
0480_handyman_service_request_item_inherited_attributes
0481_handyman_commercial_consent_bridge
0482_handyman_financial_reconciliation
0483_handyman_care_initial_scheduling_preference
```

`0469` remains absent; the existing numbering gaps are not instructions to create or renumber migrations. Although imports for 0481–0483 are not textually in execution order, the registry array places them as **0481 → 0482 → 0483**. The `Migration` type has only `id`, `up`, and `down`; it has no formal `description` field. The purpose summaries below are taken from the source-file comments, while IDs are taken from the registered migration objects and verified against filenames.

## Registered migrations 0481–0483

| Registry order | ID / file | Source-comment description | Principal existing object prerequisites |
| --- | --- | --- | --- |
| 0481 | `0481_handyman_commercial_consent_bridge` (`src/database/migrations/0481_handyman_commercial_consent_bridge.ts`) | “Additive, default-BLOCKED bridge. No issuer is enrolled by migration. Historical personal decisions/receipts retain their exact meaning.” | Handoff integration (`0375`), service requests (`0378`), quotation/decision tables (`0391`, `0394`), execution scopes (`0395`), BAST events (`0404`), Care actor registry (`0425`), and Care communications/evidence (`0451`). |
| 0482 | `0482_handyman_financial_reconciliation` (`src/database/migrations/0482_handyman_financial_reconciliation.ts`) | “Integration facts only: the existing quotation, payment, correction and settlement engines remain the ONLY money writers. No tax status/rate, inspection fee, BM percentage or integration enrollment is seeded.” | Service requests (`0378`), quotation versions (`0391`), execution scopes (`0395`), commercial agreement versions (`0406`), customer transactions/payments (`0410`, `0412`), ledger corrections (`0414`), and entitlement facts (`0416`), plus foundational Client/User records. |
| 0483 | `0483_handyman_care_initial_scheduling_preference` (`src/database/migrations/0483_handyman_care_initial_scheduling_preference.ts`) | “Existing preference store only. An attested Care actor is not a local User. Its immutable request -> attribution chain owns the initial preference; never fabricate a User/PIC to satisfy the old NOT NULL creator column.” | Channel attributions (`0374`), service requests (`0378`), scheduling readiness (`0387`), Care actor attribution provenance (`0427`), and the existing origin-channel vocabulary (`0455`). |

These are the principal earlier schema objects referenced by the migration SQL, not a machine-readable dependency graph. Dependencies are implicit in the DDL/FKs and are not declared on the `Migration` type; the runner applies the registry array in order.

## Separate pending Care migration 0484

`0484_handyman_care_structured_request_items` exists on the separate Care branch `arena/a00226eb-handyman-backend` (advertised revision `ebd6cf585097b8de16c99092ed624000a229b833`). It is pending Care-branch work, **not part of this baseline registry**: this branch contains neither its file nor an entry for it, and the current Backend registry head remains 0483. Do not copy it into, register it in, or execute it from this baseline artifact; it must follow its own approved integration/release flow. An applied `0484` history row is unknown to this 0483 artifact and is rejected by its migration runner/readiness check.

## PostgreSQL runner and execution requirements

- The migration runner is PostgreSQL-specific. It uses the `pg` client, PostgreSQL advisory locks, and migration DDL/functions including PostgreSQL types and `PL/pgSQL` triggers. Use the PostgreSQL major/version supported by the deployment and validate changes against a disposable matching environment before rollout; this documentation task did not execute 0481–0483 or establish a new version-compatibility claim.
- `npm run db:migrate` invokes the source runner; the production package script is `npm run db:migrate:prod` and runs the built `dist/database/cli.js` artifact. Use the exact reviewed release artifact and its matching database configuration.
- `migrateUp` takes the session-level PostgreSQL advisory lock `724196031` (`pg_try_advisory_lock`) and refuses to proceed if another migration runner holds it. It walks the registry array, skips recorded IDs, and wraps each migration plus its `schema_migrations` history insert in a transaction. Commits are per migration: a later failure does not undo earlier successful migrations. Unknown already-applied IDs stop the run rather than being silently accepted.
- The history table is `schema_migrations` (`id`, `applied_at`). API migration readiness requires history to match the artifact's complete registered set exactly: no missing IDs and no unknown IDs. Do not admit API traffic on a partially upgraded history.
- Important preflight detail: `npm run db:migrate:status` does not apply the registered schema migrations, but its current implementation calls `ensureMigrationHistory`, which issues `CREATE TABLE IF NOT EXISTS schema_migrations`. It can therefore create the history table when absent and is **not guaranteed to be strictly read-only**. The earlier snapshot's read-only shorthand is historical; use this current implementation detail for operations.

## Safe preflight and upgrade procedure

1. **Pin and verify the target.** Confirm the exact release artifact/commit, intended environment and database identity through the deployment's approved controls. Do not put database secrets in shell history or documentation.
2. **Inspect history without writes first.** Using an approved read-only database session, confirm the target and whether the history relation already exists. If it exists, read the applied IDs; for example:

   ```sql
   SELECT current_database() AS database_name,
          current_user AS database_role,
          current_setting('server_version') AS postgres_version,
          to_regclass('schema_migrations') AS history_table;
   -- Run the following only when history_table is non-NULL.
   SELECT id, applied_at FROM schema_migrations ORDER BY id;
   ```

   If `schema_migrations` is absent, stop and handle history initialization as an explicitly authorized operation; do not use `db:migrate:status` as a no-write probe or infer that a populated schema is fresh.
3. **Reconcile before applying.** Compare the recorded IDs with the exact release artifact's registry. For a normal upgrade, applied registrations should be a leading prefix of the array and pending entries the remaining suffix. Stop for any unknown ID, missing earlier entry, non-prefix/out-of-order history, or an unexpected `0484`; reconcile using the matching artifact and release owner before proceeding. Never delete history rows or change migration IDs to force a match.
4. **Prepare recovery and serialize deployment.** Take/verify the approved database backup or restore point, confirm the recovery plan, and coordinate the maintenance/deployment window so only one migration runner is started. Use an authorized PostgreSQL connection and the exact built artifact.
5. **Apply once, in registry order.** Run `npm run db:migrate:prod` for the built production artifact. The runner's advisory lock is an additional concurrency guard, not a substitute for deployment coordination. If it reports an active runner, wait for that run to finish and inspect its outcome; do not start a competing runner.
6. **Verify before traffic.** After a successful run, confirm all expected IDs through the status output/history and the artifact's readiness gate; for this baseline the registry tip is `0483_handyman_care_initial_scheduling_preference`, with 481 registered IDs. Only admit traffic when the deployed artifact and database history agree exactly.
7. **On failure, stop and investigate.** Preserve runner output and current history, then use the approved recovery procedure. Do not treat `db:migrate:down` as an automatic rollback: earlier per-migration transactions may already be committed, and reverse operations can be data-sensitive.

No production/staging database was queried, and no migration, status, or upgrade command was run while preparing this document. The deployed environment's applied/pending set and backup readiness therefore remain environment-specific operational checks, not assertions of this note.
