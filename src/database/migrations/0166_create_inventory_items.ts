import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16A — Inventory Item Master.
 *
 * Shared inventory catalog owned by exactly one Client.
 * Code is unique per Client (client_id + code) following asset/vendor precedent.
 *
 * Item Types: SPARE_PART, MATERIAL, CONSUMABLE (data, not behavior branch).
 * UOM: optional FK to units_of_measure (reuse BE-07 foundation). When set, service
 * enforces same Client and ACTIVE status.
 *
 * No stock balance, movement, procurement, pricing, PO, accounting here.
 * Status: ACTIVE / INACTIVE — inactive items preserved for history, not deletable.
 */
export const migration0166CreateInventoryItems: Migration = {
  id: '0166_create_inventory_items',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_items (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL REFERENCES clients (id),
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        item_type   TEXT NOT NULL,
        category    TEXT,
        uom_id      UUID REFERENCES units_of_measure (id),
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_items_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT inventory_items_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT inventory_items_type_check
          CHECK (item_type IN ('SPARE_PART', 'MATERIAL', 'CONSUMABLE'))
      )
    `);

    await client.query(`
      CREATE INDEX inventory_items_client_idx
        ON inventory_items (client_id, status);
      CREATE INDEX inventory_items_type_idx
        ON inventory_items (client_id, item_type, status);
      CREATE INDEX inventory_items_uom_idx
        ON inventory_items (uom_id);
      CREATE INDEX inventory_items_category_idx
        ON inventory_items (category)
        WHERE category IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_items');
  },
};
