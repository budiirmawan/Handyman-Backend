import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN16-PATROL-FIELD-01 PART 00 — At most one ACTIVE patrol schedule
 * binding per schedule definition.
 *
 * Cardinality defect being closed. Migration 0123 made
 * `patrol_schedule_bindings` unique on `(patrol_route_id,
 * schedule_definition_id) WHERE status = 'ACTIVE'`, which permits the SAME
 * schedule definition to hold several ACTIVE bindings — one per Patrol Route.
 * BE-07 however generates tasks with
 * `CONSTRAINT task_unique_occurrence UNIQUE (schedule_definition_id,
 * occurrence_at)` (migration 0077): exactly one generated task per schedule
 * per occurrence.
 *
 * The two invariants are incompatible for patrol execution. One generated
 * patrol task therefore matched N ACTIVE bindings — hence N Patrol Routes —
 * through the `generated_tasks → patrol_schedule_bindings` join, so "which
 * Patrol Route / binding is this Patrol Execution for" had no authoritative
 * answer. Two shipped readers masked this by consuming an arbitrary row:
 * `patrolExecutionRepository.findById` returned `rows[0]`, and
 * `listByBuilding` returned one execution row per ACTIVE binding, so a single
 * generated task could be listed as several executions on several routes.
 *
 * This migration restores 1:1 by tightening the binding side to the
 * generation side: one ACTIVE binding per schedule definition. The existing
 * per-route index is retained — it is still the correct guard for the
 * (route, schedule) pair and for INACTIVE history.
 *
 * The index is PARTIAL on `status = 'ACTIVE'`: INACTIVE historical bindings
 * are unconstrained, so a schedule may be unbound from one route and re-bound
 * (to the same or another route) without colliding with its own history.
 *
 * NO DATA IS CHOSEN OR DELETED. A pre-flight scan reports every offending
 * schedule definition and aborts the migration when duplicates exist. Picking
 * a surviving Patrol Route — or deactivating the others — is a business
 * decision about which security patrol a building actually runs, and it must
 * be made explicitly by an operator before this migration is applied, never
 * silently by the migration.
 */
export const migration0354UniqueActivePatrolBindingPerSchedule: Migration = {
  id: '0354_unique_active_patrol_binding_per_schedule',

  async up(client: PoolClient): Promise<void> {
    const duplicates = await client.query<{
      schedule_definition_id: string;
      active_binding_count: string;
      patrol_route_ids: string[];
    }>(`
      SELECT
        schedule_definition_id,
        COUNT(*)::TEXT                     AS active_binding_count,
        array_agg(patrol_route_id
                  ORDER BY patrol_route_id) AS patrol_route_ids
      FROM patrol_schedule_bindings
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
            `patrol_route_ids=[${row.patrol_route_ids.join(', ')}]`,
        )
        .join('; ');

      throw new Error(
        '0354_unique_active_patrol_binding_per_schedule: refusing to create ' +
          `patrol_schedule_bindings_schedule_active_unique because ` +
          `${duplicates.rows.length} schedule definition(s) hold more than one ` +
          `ACTIVE patrol schedule binding. Generated tasks are unique per ` +
          `(schedule_definition_id, occurrence_at), so a schedule with several ` +
          `ACTIVE patrol route bindings cannot resolve to one Patrol Route. ` +
          `Deactivate every binding but the authoritative one for each ` +
          `schedule definition and re-run the migration. No rows were ` +
          `modified. Offending rows: ${detail}`,
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX patrol_schedule_bindings_schedule_active_unique
        ON patrol_schedule_bindings (schedule_definition_id)
        WHERE status = 'ACTIVE'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS patrol_schedule_bindings_schedule_active_unique
    `);
  },
};
