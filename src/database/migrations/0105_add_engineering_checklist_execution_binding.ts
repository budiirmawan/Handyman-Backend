import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10E — links a shared BE-07 Checklist Execution back to the Engineering
 * Checklist Binding that started it.
 *
 * The column is deliberately nullable: executions created directly through
 * BE-07 carry NULL and remain untouched. No new execution table, no copied
 * checklist data — responses stay in BE-07's own `checklist_item_responses`
 * store. Mirrors the BE-08I `reviews` binding precedent.
 */
export const migration0105AddEngineeringChecklistExecutionBinding: Migration = {
  id: '0105_add_engineering_checklist_execution_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN engineering_checklist_binding_id UUID
          REFERENCES engineering_checklist_bindings (id)
    `);

    await client.query(`
      CREATE INDEX checklist_executions_engineering_binding_idx
        ON checklist_executions (engineering_checklist_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS checklist_executions_engineering_binding_idx;
      ALTER TABLE checklist_executions
        DROP COLUMN IF EXISTS engineering_checklist_binding_id
    `);
  },
};
