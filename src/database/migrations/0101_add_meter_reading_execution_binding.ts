import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10C — links a shared BE-07 Form Instance (the reading execution) back to
 * the Meter Reading Binding that started it.
 *
 * The column is deliberately nullable: instances created directly through
 * BE-07 carry NULL and remain untouched. No new instance/response table, no
 * copied measurement data — readings are written into BE-07's own
 * `form_responses` store. Mirrors the BE-08I `reviews` binding precedent.
 */
export const migration0101AddMeterReadingExecutionBinding: Migration = {
  id: '0101_add_meter_reading_execution_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_instances
        ADD COLUMN meter_reading_binding_id UUID
          REFERENCES meter_reading_bindings (id)
    `);

    await client.query(`
      CREATE INDEX form_instances_meter_reading_binding_idx
        ON form_instances (meter_reading_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS form_instances_meter_reading_binding_idx;
      ALTER TABLE form_instances
        DROP COLUMN IF EXISTS meter_reading_binding_id
    `);
  },
};
