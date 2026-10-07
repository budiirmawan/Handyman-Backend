import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15B — Vendor Work.
 *
 * Records the operational execution of a Vendor against a Work Order. It is
 * deliberately NOT a second work/execution engine: it references a BE-15A
 * Vendor Assignment (which itself references the BE-06 Vendor master and the
 * BE-08 Work Order) and carries only the vendor-work lifecycle.
 *
 *   Vendor Assignment → Vendor Work → Work Order (in a Building)
 *
 * One Vendor Work record per Vendor Assignment is enforced by the UNIQUE
 * constraint on `vendor_assignment_id` — the "resolve/create context" flow is
 * therefore idempotent and can never fan out duplicates.
 *
 * `vendor_id` and `building_id` are denormalized for scoped listing, but they
 * are ALWAYS derived authoritatively by the service from the Assignment /
 * Work Order (never trusted from the client), so they can never drift from
 * BE-15A / BE-08.
 *
 * The `status` CHECK pins the full vendor-work lifecycle to the explicit
 * backend transition table (`NOT_STARTED → IN_PROGRESS → ON_HOLD →
 * COMPLETED`, resume `ON_HOLD → IN_PROGRESS`): `started_at` is null until the
 * work first starts, and `completed_at` is set exactly when the work reaches
 * COMPLETED. Completion / rework of the underlying Work Order remains BE-08's
 * authority — this table never overwrites it.
 */
export const migration0156CreateVendorWorks: Migration = {
  id: '0156_create_vendor_works',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_works (
        id                   UUID PRIMARY KEY,
        vendor_assignment_id UUID NOT NULL,
        vendor_id            UUID NOT NULL,
        work_order_id        UUID NOT NULL,
        building_id          UUID NOT NULL,
        status               TEXT NOT NULL DEFAULT 'NOT_STARTED',
        notes                TEXT,
        started_at           TIMESTAMPTZ,
        completed_at         TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_works_assignment_id_fkey
          FOREIGN KEY (vendor_assignment_id) REFERENCES vendor_assignments (id),
        CONSTRAINT vendor_works_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_works_work_order_id_fkey
          FOREIGN KEY (work_order_id) REFERENCES work_orders (id),
        CONSTRAINT vendor_works_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT vendor_works_assignment_unique
          UNIQUE (vendor_assignment_id),
        CONSTRAINT vendor_works_status_check
          CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED')),
        CONSTRAINT vendor_works_state_check CHECK (
          (status = 'NOT_STARTED'
             AND started_at IS NULL AND completed_at IS NULL)
          OR (status IN ('IN_PROGRESS', 'ON_HOLD')
             AND started_at IS NOT NULL AND completed_at IS NULL)
          OR (status = 'COMPLETED'
             AND started_at IS NOT NULL AND completed_at IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE INDEX vendor_works_vendor_idx
        ON vendor_works (vendor_id, status);
      CREATE INDEX vendor_works_work_order_idx
        ON vendor_works (work_order_id, status);
      CREATE INDEX vendor_works_building_idx
        ON vendor_works (building_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_works');
  },
};
