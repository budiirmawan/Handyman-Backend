import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12E — links a shared BE-07 Checklist Execution back to the Patrol
 * Checklist Binding that started it.
 *
 * The column is deliberately nullable: executions created directly through
 * BE-07 carry NULL and remain untouched. No new execution table, no copied
 * checklist data — responses stay in BE-07's own `checklist_item_responses`
 * store. Mirrors the BE-10E `engineering_checklist_binding_id` precedent
 * (migration 0105).
 */
export const migration0126AddPatrolChecklistExecutionBinding: Migration = {
  id: '0126_add_patrol_checklist_execution_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN patrol_checklist_binding_id UUID
          REFERENCES patrol_checklist_bindings (id)
    `);

    await client.query(`
      CREATE INDEX checklist_executions_patrol_binding_idx
        ON checklist_executions (patrol_checklist_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS checklist_executions_patrol_binding_idx;
      ALTER TABLE checklist_executions
        DROP COLUMN IF EXISTS patrol_checklist_binding_id
    `);
  },
};
