import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 00 — Work Order procurement parent.
 *
 * Canonical field relation:
 *
 *   Work Order → one Work-Order field Purchase Request → many material_requests
 *
 * The Work Order relationship lives on the procurement HEADER
 * (`purchase_requests`), never duplicated on every `material_requests` line.
 * `work_order_id` is nullable: every historical / management Purchase Request
 * stays valid with NULL and is NOT backfilled. A field-generated parent carries
 * the Work Order id, and the partial unique index guarantees at most ONE field
 * parent per Work Order — this index is the race arbiter for the
 * get-or-create helper.
 *
 * `work_order_procurement_bindings` (BE-17H, one row per Work Order,
 * `wo_procurement_work_order_unique`) is left completely untouched; it remains
 * the legacy/general procurement binding contract.
 */
export const migration0350AddPurchaseRequestWorkOrder: Migration = {
  id: '0350_add_purchase_request_work_order',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE purchase_requests
        ADD COLUMN work_order_id UUID REFERENCES work_orders (id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX purchase_requests_work_order_unique
        ON purchase_requests (work_order_id)
        WHERE work_order_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS purchase_requests_work_order_unique;
      ALTER TABLE purchase_requests DROP COLUMN IF EXISTS work_order_id
    `);
  },
};
