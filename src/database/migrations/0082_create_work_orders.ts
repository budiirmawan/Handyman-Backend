import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08B — Work Order Domain.
 *
 * A Work Order is the formal operational work record, created directly or
 * converted from an existing Work Request (BE-08A). It is deliberately
 * minimal: identity, core metadata, and a single initial status. Detailed
 * Priority / Status / Lifecycle belongs to BE-08C; Asset binding, assignment,
 * execution, evidence, completion, verification, and history belong to later
 * BE-08 PARTs and are intentionally absent here.
 *
 * `work_type` is a data-driven code string (never a hardcoded Engineering-,
 * Housekeeping-, or Security-specific model). Client ownership is stored
 * directly but derived authoritatively by the service from Building →
 * Property → Client, so isolation can never drift from BE-02.
 *
 * `work_request_id` is optional: a direct Work Order has none, a converted
 * one points at its source request. The UNIQUE constraint guarantees a Work
 * Request can never produce more than one Work Order (PostgreSQL allows
 * multiple NULLs, so direct Work Orders are unaffected).
 */
export const migration0082CreateWorkOrders: Migration = {
  id: '0082_create_work_orders',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_orders (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        work_order_number TEXT NOT NULL,
        work_request_id UUID REFERENCES work_requests (id),
        title TEXT NOT NULL,
        description TEXT,
        work_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_order_status
          CHECK (status IN ('OPEN')),
        CONSTRAINT work_order_number_unique
          UNIQUE (client_id, work_order_number),
        CONSTRAINT work_order_from_request_unique
          UNIQUE (work_request_id)
      )
    `);

    await client.query(`
      CREATE INDEX work_orders_client_idx
        ON work_orders (client_id, status, created_at);
      CREATE INDEX work_orders_building_idx
        ON work_orders (building_id, status, created_at);
      CREATE INDEX work_orders_work_type_idx
        ON work_orders (work_type, status);
      CREATE INDEX work_orders_request_idx
        ON work_orders (work_request_id);
      CREATE INDEX work_orders_creator_idx
        ON work_orders (created_by_user_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_orders');
  },
};
