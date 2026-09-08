import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MAT-01 PART 01 — Receiving ↔ Material Request line binding.
 *
 * Adds a stable, optional reference from a material Receiving (BE-17G) to the
 * authoritative Material Request line (BE-17B) it fulfils, preserving:
 *
 *   Material Request → Material Request Line → Receiving → Stock In
 *
 * The binding is deliberately additive and optional so existing receiving
 * behavior stays compatible; when present, the service enforces line identity
 * (same Purchase Request, same item, same Client/Building scope) and the
 * cumulative over-receipt guard (received + new ≤ requested line quantity).
 *
 * No new Material Request, Receiving, or Inventory authority is created here.
 * Approved-quantity, post-approval freeze, ledger remediation, UOM snapshot,
 * and cost concerns belong to later CR-BE-MAT-01 PARTs.
 */
export const migration0264AddReceivingMaterialRequestBinding: Migration = {
  id: '0264_add_receiving_material_request_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE receivings
        ADD COLUMN material_request_id UUID REFERENCES material_requests (id),
        ADD CONSTRAINT receiving_material_request_material_only
          CHECK (material_request_id IS NULL OR receiving_type = 'MATERIAL')
    `);

    await client.query(`
      CREATE INDEX receivings_material_request_idx
        ON receivings (material_request_id, status)
        WHERE material_request_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS receivings_material_request_idx;
      ALTER TABLE receivings
        DROP CONSTRAINT IF EXISTS receiving_material_request_material_only,
        DROP COLUMN IF EXISTS material_request_id
    `);
  },
};
