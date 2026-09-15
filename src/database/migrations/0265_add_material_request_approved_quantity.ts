import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MAT-01 PART 02 — Approved Quantity & Material Request Freeze.
 *
 * Adds the authoritative approved quantity to the existing Material Request
 * line (BE-17B) — no new Material Request authority is created:
 *
 * - `approved_quantity` — the fulfilment authority used downstream (PART 01
 *   receiving cap). Defaults to the requested quantity when approval does not
 *   explicitly change it. Always > 0 and never above the requested quantity
 *   (no existing business rule permits over-approval).
 * - `approved_at` / `approved_by_user_id` — approval provenance (reuses the
 *   BE-17D approval decision actor).
 * - status gains 'APPROVED' (OPEN → APPROVED | CANCELLED). Once APPROVED the
 *   service layer freezes fulfilment-critical fields (item, quantities,
 *   scope); correction goes through the existing cancellation path.
 *
 * The requested `quantity` column is preserved untouched. Historical rows are
 * NOT rewritten: `approved_quantity` stays NULL on them and downstream logic
 * falls back to the requested quantity (backward compatible).
 */
export const migration0265AddMaterialRequestApprovedQuantity: Migration = {
  id: '0265_add_material_request_approved_quantity',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE material_requests
        ADD COLUMN approved_quantity    NUMERIC,
        ADD COLUMN approved_at          TIMESTAMPTZ,
        ADD COLUMN approved_by_user_id  UUID REFERENCES users (id)
    `);

    await client.query(`
      ALTER TABLE material_requests
        DROP CONSTRAINT material_request_status
    `);

    await client.query(`
      ALTER TABLE material_requests
        ADD CONSTRAINT material_request_status
          CHECK (status IN ('OPEN', 'APPROVED', 'CANCELLED')),
        ADD CONSTRAINT material_request_approved_quantity_positive
          CHECK (approved_quantity IS NULL OR approved_quantity > 0),
        ADD CONSTRAINT material_request_approved_quantity_le_requested
          CHECK (approved_quantity IS NULL OR approved_quantity <= quantity),
        ADD CONSTRAINT material_request_approved_consistency
          CHECK (
            status <> 'APPROVED'
            OR (
              approved_quantity IS NOT NULL
              AND approved_at IS NOT NULL
              AND approved_by_user_id IS NOT NULL
            )
          )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE material_requests
        DROP CONSTRAINT IF EXISTS material_request_approved_consistency,
        DROP CONSTRAINT IF EXISTS material_request_approved_quantity_le_requested,
        DROP CONSTRAINT IF EXISTS material_request_approved_quantity_positive,
        DROP CONSTRAINT IF EXISTS material_request_status
    `);
    await client.query(
      `UPDATE material_requests SET status = 'OPEN' WHERE status = 'APPROVED'`,
    );
    await client.query(`
      ALTER TABLE material_requests
        ADD CONSTRAINT material_request_status
          CHECK (status IN ('OPEN', 'CANCELLED')),
        DROP COLUMN IF EXISTS approved_by_user_id,
        DROP COLUMN IF EXISTS approved_at,
        DROP COLUMN IF EXISTS approved_quantity
    `);
  },
};
