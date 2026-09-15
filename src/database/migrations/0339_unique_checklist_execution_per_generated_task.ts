import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * MOB-C04 PART 02B — At most one checklist execution per generated task.
 *
 * Enforces the get-or-create invariant that backs the authoritative
 * task → checklist-execution command: a generated field task owns exactly one
 * bound checklist execution (or none). Without this, concurrent mobile taps /
 * retries of "open the checklist for my task" could create duplicate bound
 * executions even though the service is written get-or-create.
 *
 * The index is PARTIAL on non-null `generated_task_id`: standalone / admin /
 * domain executions (NULL binding) are untouched and never constrained.
 * Backed by the `checklist_executions.generated_task_id` column added in
 * migration 0338.
 */
export const migration0339UniqueChecklistExecutionPerGeneratedTask: Migration = {
  id: '0339_unique_checklist_execution_per_generated_task',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE UNIQUE INDEX checklist_executions_generated_task_unique
        ON checklist_executions (generated_task_id)
        WHERE generated_task_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS checklist_executions_generated_task_unique
    `);
  },
};
