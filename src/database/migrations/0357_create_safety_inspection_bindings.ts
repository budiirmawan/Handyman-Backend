import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN19-SAFETY-INSPECTION-01 — Safety Inspection binding.
 *
 * This is configuration only. Execution remains the existing generated Task →
 * Checklist Execution contract. One ACTIVE binding is allowed per Schedule
 * Definition so a generated task can resolve to zero or one Safety Inspection
 * marker without winner selection.
 */
export const migration0357CreateSafetyInspectionBindings: Migration = {
  id: '0357_create_safety_inspection_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE safety_inspection_bindings (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        schedule_definition_id UUID NOT NULL REFERENCES schedule_definitions (id),
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT safety_inspection_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    // Pre-flight is explicit even though this migration creates the table empty:
    // any pre-existing/corrupt ACTIVE duplicates must fail the migration rather
    // than being repaired or silently winner-selected.
    const duplicates = await client.query<{ schedule_definition_id: string }>(`
      SELECT schedule_definition_id
        FROM safety_inspection_bindings
       WHERE status = 'ACTIVE'
       GROUP BY schedule_definition_id
      HAVING COUNT(*) > 1
    `);
    if (duplicates.rowCount !== null && duplicates.rowCount > 0) {
      throw new Error(
        'Safety Inspection binding migration pre-flight failed: duplicate ACTIVE schedule definitions exist.',
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX safety_inspection_bindings_schedule_active_unique
        ON safety_inspection_bindings (schedule_definition_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX safety_inspection_bindings_client_idx
        ON safety_inspection_bindings (client_id, status);
      CREATE INDEX safety_inspection_bindings_building_idx
        ON safety_inspection_bindings (building_id, status);
      CREATE INDEX safety_inspection_bindings_schedule_idx
        ON safety_inspection_bindings (schedule_definition_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS safety_inspection_bindings');
  },
};
