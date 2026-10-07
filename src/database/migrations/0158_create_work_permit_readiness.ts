import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15D — Work Permit Readiness.
 *
 * A readiness/binding layer only — NOT a Permit-to-Work engine. Each row
 * records the permit-readiness of a BE-15B Vendor Work for one permit
 * requirement type: the permit reference, its status, the validity window,
 * the backend-derived readiness status, and notes.
 *
 *   Vendor Work → Work Permit Readiness (per requirement type)
 *
 * `client_id`, `building_id`, and `work_order_id` are stored directly but
 * derived authoritatively by the service from the Vendor Work → Work Order,
 * so isolation can never drift from BE-08 / BE-02. `readiness_status` is
 * derived backend-side from the permit requirement type, permit status, and
 * validity window — never trusted from the client.
 *
 * One readiness row per (Vendor Work, permit requirement type) is enforced by
 * the UNIQUE constraint; updates mutate that row while change history is
 * preserved through the shared BE-07 operational-events timeline.
 */
export const migration0158CreateWorkPermitReadiness: Migration = {
  id: '0158_create_work_permit_readiness',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_permit_readiness (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        vendor_work_id         UUID NOT NULL REFERENCES vendor_works (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        work_order_id          UUID NOT NULL REFERENCES work_orders (id),
        permit_requirement_type TEXT NOT NULL,
        permit_reference       TEXT,
        permit_status          TEXT NOT NULL DEFAULT 'PENDING',
        valid_from             TIMESTAMPTZ,
        valid_until            TIMESTAMPTZ,
        readiness_status       TEXT NOT NULL,
        notes                  TEXT,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_permit_readiness_unique
          UNIQUE (vendor_work_id, permit_requirement_type),
        CONSTRAINT work_permit_readiness_status_check
          CHECK (readiness_status IN
            ('READY', 'NOT_READY', 'EXPIRED', 'NOT_REQUIRED')),
        CONSTRAINT work_permit_readiness_permit_status_check
          CHECK (permit_status IN
            ('DRAFT', 'PENDING', 'ISSUED', 'SUSPENDED', 'REJECTED',
             'REVOKED', 'EXPIRED')),
        CONSTRAINT work_permit_readiness_validity_check
          CHECK (
            valid_from IS NULL
            OR valid_until IS NULL
            OR valid_until >= valid_from
          )
      )
    `);

    await client.query(`
      CREATE INDEX work_permit_readiness_work_idx
        ON work_permit_readiness (vendor_work_id);
      CREATE INDEX work_permit_readiness_building_idx
        ON work_permit_readiness (building_id, readiness_status);
      CREATE INDEX work_permit_readiness_work_order_idx
        ON work_permit_readiness (work_order_id, readiness_status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_permit_readiness');
  },
};
