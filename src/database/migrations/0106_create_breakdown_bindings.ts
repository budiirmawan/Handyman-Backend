import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10F — Breakdown / Corrective Binding.
 *
 * The minimal Engineering binding that associates a BE-05 Asset / Equipment
 * with a breakdown/corrective event: category, description, reporter,
 * reported-at, an optional BE-04 Functional Location refinement, and an
 * optional corrective BE-08 Work Order link.
 *
 * This table holds references only — Work Order, Finding, Evidence,
 * Assignment, and Verification masters are never duplicated. The corrective
 * Work Order is created and driven exclusively through the BE-08 service;
 * its lifecycle, assignments (BE-03/BE-06), and verification remain
 * BE-08's.
 *
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from Asset → Building → Property → Client, so isolation can
 * never drift from BE-02. At most one corrective Work Order per breakdown is
 * enforced by a UNIQUE constraint on `work_order_id`.
 */
export const migration0106CreateBreakdownBindings: Migration = {
  id: '0106_create_breakdown_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE breakdown_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        asset_id               UUID NOT NULL REFERENCES assets (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        work_order_id          UUID UNIQUE REFERENCES work_orders (id),
        category               TEXT NOT NULL,
        description            TEXT NOT NULL,
        reported_by_user_id    UUID NOT NULL REFERENCES users (id),
        reported_at            TIMESTAMPTZ NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'OPEN',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT breakdown_binding_status
          CHECK (status IN ('OPEN', 'CLOSED'))
      )
    `);

    await client.query(`
      CREATE INDEX breakdown_bindings_asset_idx
        ON breakdown_bindings (asset_id, status);
      CREATE INDEX breakdown_bindings_building_idx
        ON breakdown_bindings (building_id, status);
      CREATE INDEX breakdown_bindings_work_order_idx
        ON breakdown_bindings (work_order_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS breakdown_bindings');
  },
};
