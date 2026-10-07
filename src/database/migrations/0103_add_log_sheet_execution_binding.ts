import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10D — links a shared BE-07 Form Instance (the log sheet execution) back
 * to the Equipment Log Sheet Binding that started it.
 *
 * The column is deliberately nullable: instances created directly through
 * BE-07 carry NULL and remain untouched. No new instance/response table, no
 * copied log data — rows are written into BE-07's own `form_responses`
 * store. Mirrors the BE-08I `reviews` binding precedent.
 */
export const migration0103AddLogSheetExecutionBinding: Migration = {
  id: '0103_add_log_sheet_execution_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_instances
        ADD COLUMN log_sheet_binding_id UUID
          REFERENCES log_sheet_bindings (id)
    `);

    await client.query(`
      CREATE INDEX form_instances_log_sheet_binding_idx
        ON form_instances (log_sheet_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS form_instances_log_sheet_binding_idx;
      ALTER TABLE form_instances
        DROP COLUMN IF EXISTS log_sheet_binding_id
    `);
  },
};
