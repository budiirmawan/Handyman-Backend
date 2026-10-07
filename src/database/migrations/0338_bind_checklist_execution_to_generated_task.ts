import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * MOB-C04 PART 02A — Checklist Execution → Generated Task binding.
 *
 * Adds the minimal, backend-authoritative persistence relationship so a field
 * checklist execution can be resolved to its work instance authoritatively:
 *
 *   checklist_executions.generated_task_id  →  generated_tasks.id
 *                                            →  generated_tasks.building_id
 *
 * This addresses the MOB-C04 PART 02 authority-review finding that
 * `checklist_executions` has no generic work-instance link and that resolving
 * a Building by "first generated task targeting the same checklist template"
 * is ambiguous (a template may be targeted by many tasks across many
 * Buildings/workers/occurrences) and must not be used as an authorization
 * grant.
 *
 * Design notes:
 *  - The column is NULLABLE and defaults to NULL. Not every checklist
 *    execution belongs to a generated task: standalone/admin executions and
 *    the domain-bound executions (patrol / inspection / engineering / vendor,
 *    which carry their own binding FK) remain valid with NULL. No backfill is
 *    performed: historical rows are ambiguous and must stay NULL rather than
 *    being guessed from checklist_template_id.
 *  - Referential integrity only: a non-null value must reference an existing
 *    generated task. The FK deliberately has NO ON DELETE/ON UPDATE clause
 *    (NO ACTION), matching the platform convention for operational/master
 *    references (e.g. migration 0337) — a referenced task that is still used
 *    by an execution is not silently orphaned.
 *  - A lookup index supports the "which task owns this execution" resolution.
 *
 * This migration is persistence foundation only: it adds no API, DTO or
 * runtime authorization behavior. A client must never bind an execution to an
 * arbitrary task merely by sending generatedTaskId unless a backend-validated
 * task-authority command exists; that write-time binding is delivered
 * separately and only from backend workflow authority.
 */
export const migration0338BindChecklistExecutionToGeneratedTask: Migration = {
  id: '0338_bind_checklist_execution_to_generated_task',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN generated_task_id UUID,
        ADD CONSTRAINT checklist_executions_generated_task_id_fkey
          FOREIGN KEY (generated_task_id) REFERENCES generated_tasks (id)
    `);

    await client.query(`
      CREATE INDEX checklist_executions_generated_task_id_idx
        ON checklist_executions (generated_task_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS checklist_executions_generated_task_id_idx;
      ALTER TABLE checklist_executions
        DROP CONSTRAINT IF EXISTS checklist_executions_generated_task_id_fkey,
        DROP COLUMN IF EXISTS generated_task_id
    `);
  },
};
