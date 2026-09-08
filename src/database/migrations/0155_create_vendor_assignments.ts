import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15A — Vendor Assignment.
 *
 * Records that an operational Work Order (BE-08B) is being handled by an
 * existing Vendor (BE-06A). This is the first operational piece of BE-15
 * Vendor Operations; it deliberately reuses the BE-06 Vendor master and the
 * BE-08 Work Order as references — no second Vendor or Work Order engine is
 * created here.
 *
 *   Vendor → Vendor Assignment → Work Order (in a Building)
 *
 * `building_id` is denormalized for scoped listing / isolation, but it is
 * ALWAYS derived authoritatively by the service from the Work Order's own
 * Building (never trusted from the client), so it can never drift from
 * BE-08.
 *
 * `assigned_at` defaults to creation time; `assigned_by_user_id` records the
 * acting backend User. `status` is ACTIVE / INACTIVE — assignments are
 * deactivated, never hard-deleted, so history is preserved (BE-15K).
 *
 * Duplicate protection follows the BE-06D / BE-07 idiom: a partial unique
 * index over ACTIVE rows ensures one Vendor holds a given Work Order at most
 * once at a time, while still allowing several different Vendors on the same
 * Work Order and preserving INACTIVE history. The cross-table rules the FKs
 * cannot express — Vendor must be ACTIVE and hold an ACTIVE Vendor ↔
 * Building relationship to the Work Order's Building, and Vendor + Work Order
 * must resolve to the same Client — live in the service layer.
 */
export const migration0155CreateVendorAssignments: Migration = {
  id: '0155_create_vendor_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_assignments (
        id                  UUID PRIMARY KEY,
        vendor_id           UUID NOT NULL,
        work_order_id       UUID NOT NULL,
        building_id         UUID NOT NULL,
        status              TEXT NOT NULL DEFAULT 'ACTIVE',
        notes               TEXT,
        assigned_by_user_id UUID NOT NULL,
        assigned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_assignments_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_assignments_work_order_id_fkey
          FOREIGN KEY (work_order_id) REFERENCES work_orders (id),
        CONSTRAINT vendor_assignments_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT vendor_assignments_assigned_by_fkey
          FOREIGN KEY (assigned_by_user_id) REFERENCES users (id),
        CONSTRAINT vendor_assignments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    // One ACTIVE assignment per (vendor, work_order); INACTIVE history is
    // retained, and a Work Order may still hold several different Vendors.
    await client.query(`
      CREATE UNIQUE INDEX vendor_assignments_active_unique
        ON vendor_assignments (vendor_id, work_order_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX vendor_assignments_vendor_idx
        ON vendor_assignments (vendor_id, status);
      CREATE INDEX vendor_assignments_work_order_idx
        ON vendor_assignments (work_order_id, status);
      CREATE INDEX vendor_assignments_building_idx
        ON vendor_assignments (building_id, status);
      CREATE INDEX vendor_assignments_assigner_idx
        ON vendor_assignments (assigned_by_user_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_assignments');
  },
};
