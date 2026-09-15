import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10B — links a shared BE-07 Checklist Execution back to the Equipment
 * Inspection Binding that started it.
 *
 * The column is deliberately nullable: executions created directly through
 * BE-07 carry NULL and remain untouched. No new execution table, no copied
 * execution data — this is a pure reference, mirroring how BE-08I binds
 * Work Order verification through the shared BE-07 reviews table.
 */
export const migration0099AddInspectionExecutionBinding: Migration = {
  id: '0099_add_inspection_execution_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN inspection_binding_id UUID REFERENCES inspection_bindings (id)
    `);

    await client.query(`
      CREATE INDEX checklist_executions_inspection_binding_idx
        ON checklist_executions (inspection_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS checklist_executions_inspection_binding_idx;
      ALTER TABLE checklist_executions
        DROP COLUMN IF EXISTS inspection_binding_id
    `);
  },
};
