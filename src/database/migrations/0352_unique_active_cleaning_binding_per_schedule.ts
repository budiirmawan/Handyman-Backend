import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 00 — At most one ACTIVE cleaning schedule
 * binding per schedule definition.
 *
 * Cardinality defect being closed. Migration 0112 made
 * `cleaning_schedule_bindings` unique on `(cleaning_area_id,
 * schedule_definition_id) WHERE status = 'ACTIVE'`, which permits the SAME
 * schedule definition to hold several ACTIVE bindings — one per Cleaning Area.
 * BE-07 however generates tasks with
 * `CONSTRAINT task_unique_occurrence UNIQUE (schedule_definition_id,
 * occurrence_at)` (migration 0077): exactly one generated task per schedule
 * per occurrence.
 *
 * The two invariants are incompatible for cleaning execution. One generated
 * cleaning task therefore fanned out to N Cleaning Areas through the
 * `daily-cleaning` join (`generated_tasks → cleaning_schedule_bindings →
 * cleaning_areas`), so "which Cleaning Area is this cleaning execution for"
 * had no authoritative answer. `dailyCleaningRepository.findById` masked this
 * by returning `rows[0]` — an arbitrary row picked by whatever order Postgres
 * happened to return.
 *
 * This migration restores 1:1 by tightening the binding side to the
 * generation side: one ACTIVE binding per schedule definition. The existing
 * per-area index is retained — it is still the correct guard for the
 * (area, schedule) pair and for INACTIVE history.
 *
 * The index is PARTIAL on `status = 'ACTIVE'`: INACTIVE historical bindings are
 * unconstrained, so an area/schedule pair may be unbound and re-bound without
 * colliding with its own history.
 *
 * NO DATA IS CHOSEN OR DELETED. A pre-flight scan reports every offending
 * schedule definition and aborts the migration when duplicates exist. Picking
 * a surviving area — or deactivating the others — is a business decision about
 * which Cleaning Area a cleaning crew actually services, and it must be made
 * explicitly by an operator before this migration is applied, never silently
 * by the migration.
 */
export const migration0352UniqueActiveCleaningBindingPerSchedule: Migration = {
  id: '0352_unique_active_cleaning_binding_per_schedule',

  async up(client: PoolClient): Promise<void> {
    const duplicates = await client.query<{
      schedule_definition_id: string;
      active_binding_count: string;
      cleaning_area_ids: string[];
    }>(`
      SELECT
        schedule_definition_id,
        COUNT(*)::TEXT                AS active_binding_count,
        array_agg(cleaning_area_id
                  ORDER BY cleaning_area_id) AS cleaning_area_ids
      FROM cleaning_schedule_bindings
      WHERE status = 'ACTIVE'
      GROUP BY schedule_definition_id
      HAVING COUNT(*) > 1
      ORDER BY schedule_definition_id
    `);

    if (duplicates.rows.length > 0) {
      const detail = duplicates.rows
        .map(
          (row) =>
            `schedule_definition_id=${row.schedule_definition_id} ` +
            `active_bindings=${row.active_binding_count} ` +
            `cleaning_area_ids=[${row.cleaning_area_ids.join(', ')}]`,
        )
        .join('; ');

      throw new Error(
        '0352_unique_active_cleaning_binding_per_schedule: refusing to create ' +
          `cleaning_schedule_bindings_schedule_active_unique because ` +
          `${duplicates.rows.length} schedule definition(s) hold more than one ` +
          `ACTIVE cleaning schedule binding. Generated tasks are unique per ` +
          `(schedule_definition_id, occurrence_at), so a schedule with several ` +
          `ACTIVE cleaning areas cannot resolve to one Cleaning Area. ` +
          `Deactivate every binding but the authoritative one for each ` +
          `schedule definition and re-run the migration. No rows were ` +
          `modified. Offending rows: ${detail}`,
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX cleaning_schedule_bindings_schedule_active_unique
        ON cleaning_schedule_bindings (schedule_definition_id)
        WHERE status = 'ACTIVE'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS cleaning_schedule_bindings_schedule_active_unique
    `);
  },
};
