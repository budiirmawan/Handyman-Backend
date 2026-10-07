import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10G — Maintenance Operational Binding.
 *
 * The minimal Engineering binding that associates a BE-05 Asset / Equipment
 * with a maintenance context (name / type / description), an optional BE-04
 * Functional Location refinement, an optional shared BE-07 Schedule, and an
 * optional BE-08 Work Order.
 *
 * This table holds references only — Scheduler, Task, Work Order, Checklist,
 * Evidence, Assignment, Finding, and Verification masters are never
 * duplicated. Schedules, tasks, and Work Orders are created and driven
 * exclusively through BE-07 / BE-08.
 *
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from Asset → Building → Property → Client, so isolation can
 * never drift from BE-02. At most one Schedule and one Work Order per binding
 * are enforced by UNIQUE constraints on the reference columns.
 */
export const migration0107CreateMaintenanceBindings: Migration = {
  id: '0107_create_maintenance_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE maintenance_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        asset_id               UUID NOT NULL REFERENCES assets (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        schedule_definition_id UUID UNIQUE REFERENCES schedule_definitions (id),
        work_order_id          UUID UNIQUE REFERENCES work_orders (id),
        name                   TEXT NOT NULL,
        maintenance_type       TEXT NOT NULL,
        description            TEXT,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT maintenance_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT maintenance_binding_type
          CHECK (maintenance_type IN (
            'PREVENTIVE', 'PREDICTIVE', 'CONDITION_BASED', 'CALIBRATION'
          ))
      )
    `);

    await client.query(`
      CREATE INDEX maintenance_bindings_asset_idx
        ON maintenance_bindings (asset_id, status);
      CREATE INDEX maintenance_bindings_building_idx
        ON maintenance_bindings (building_id, status);
      CREATE INDEX maintenance_bindings_schedule_idx
        ON maintenance_bindings (schedule_definition_id);
      CREATE INDEX maintenance_bindings_work_order_idx
        ON maintenance_bindings (work_order_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS maintenance_bindings');
  },
};
