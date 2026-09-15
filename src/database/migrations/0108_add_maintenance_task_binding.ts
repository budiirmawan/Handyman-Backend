import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10G — links a BE-07 generated Task back to the Maintenance Binding that
 * tracks it.
 *
 * The column is deliberately nullable: tasks generated directly through BE-07
 * carry NULL and remain untouched. No new task table, no copied task data —
 * this is a pure reference, mirroring the BE-08I `reviews` binding
 * precedent. Tasks remain generated and executed exclusively through BE-07.
 */
export const migration0108AddMaintenanceTaskBinding: Migration = {
  id: '0108_add_maintenance_task_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE generated_tasks
        ADD COLUMN maintenance_binding_id UUID
          REFERENCES maintenance_bindings (id)
    `);

    await client.query(`
      CREATE INDEX generated_tasks_maintenance_binding_idx
        ON generated_tasks (maintenance_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS generated_tasks_maintenance_binding_idx;
      ALTER TABLE generated_tasks
        DROP COLUMN IF EXISTS maintenance_binding_id
    `);
  },
};
