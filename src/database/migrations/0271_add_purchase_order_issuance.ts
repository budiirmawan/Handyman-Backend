import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-R2P-01 PART 03 — PO Issue / Status / Approval Readiness.
 *
 * Adds the MINIMUM issuance metadata to the existing Purchase Order (0269):
 *
 *   - `issued_at`           — when the commitment was issued to the Vendor
 *   - `issued_by_user_id`   — who issued it (issuance provenance)
 *
 * Additive only, mirroring how 0262/0263 extended `vendor_invoices` — the
 * DRAFT foundation from PART 01 and the PO Lines from PART 02 are untouched.
 *
 * NO SECOND READINESS AUTHORITY IS CREATED. BE-17F `purchase_order_readiness`
 * remains the sole readiness authority and stays a PRECONDITION: issuance
 * re-reads its verdict and refuses anything that is not READY. No readiness
 * verdict, checks or blocker set is persisted on the Purchase Order.
 *
 * MR/SR remain the quantity authority — no quantity, receiving, inventory or
 * over-receipt column or rule is added or changed here.
 *
 * State integrity (API lifecycle DRAFT → ISSUED or DRAFT → CANCELLED):
 *   - DRAFT      → issuance columns are both NULL
 *   - ISSUED     → issuance columns are both NOT NULL
 *   - CANCELLED  → API-created rows have both issuance columns NULL.
 *                  The constraint also accepts both NOT NULL to preserve
 *                  historical/imported issued-cancelled provenance; that
 *                  storage compatibility is not an API transition.
 */
export const migration0271AddPurchaseOrderIssuance: Migration = {
  id: '0271_add_purchase_order_issuance',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE purchase_orders
        ADD COLUMN issued_at          TIMESTAMPTZ,
        ADD COLUMN issued_by_user_id  UUID REFERENCES users (id)
    `);

    // Issuance state integrity. Cancellation integrity (0269) is unchanged
    // and continues to be enforced by purchase_orders_cancel_state_check.
    await client.query(`
      ALTER TABLE purchase_orders
        ADD CONSTRAINT purchase_orders_issue_state_check
          CHECK (
            (status = 'DRAFT'
              AND issued_at IS NULL AND issued_by_user_id IS NULL)
            OR (status = 'ISSUED'
              AND issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL)
            OR (status = 'CANCELLED' AND (
                 (issued_at IS NULL AND issued_by_user_id IS NULL)
                 OR (issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL)
               ))
          )
    `);

    await client.query(`
      CREATE INDEX purchase_orders_issued_idx
        ON purchase_orders (issued_at DESC)
        WHERE issued_at IS NOT NULL
    `);

    // The append-only audit trail gains the ISSUED action.
    await client.query(`
      ALTER TABLE purchase_order_history
        DROP CONSTRAINT purchase_order_history_action_check
    `);
    await client.query(`
      ALTER TABLE purchase_order_history
        ADD CONSTRAINT purchase_order_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'ISSUED', 'CANCELLED'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Historical ISSUED audit rows would violate the narrower pre-PART-03
    // constraint, so they are folded back to UPDATED before it is restored.
    await client.query(`
      UPDATE purchase_order_history SET action = 'UPDATED' WHERE action = 'ISSUED'
    `);
    await client.query(`
      ALTER TABLE purchase_order_history
        DROP CONSTRAINT IF EXISTS purchase_order_history_action_check
    `);
    await client.query(`
      ALTER TABLE purchase_order_history
        ADD CONSTRAINT purchase_order_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'CANCELLED'))
    `);

    // Likewise, an ISSUED Purchase Order cannot exist without the issuance
    // columns; return those rows to DRAFT before dropping them.
    //
    // The issue-state constraint is dropped FIRST: it requires a DRAFT row to
    // carry no issuance provenance, so folding ISSUED → DRAFT while the
    // columns are still populated would violate the very constraint that is
    // on its way out.
    await client.query(`
      ALTER TABLE purchase_orders
        DROP CONSTRAINT IF EXISTS purchase_orders_issue_state_check
    `);
    await client.query(`
      UPDATE purchase_orders SET status = 'DRAFT' WHERE status = 'ISSUED'
    `);
    await client.query(`
      DROP INDEX IF EXISTS purchase_orders_issued_idx
    `);
    await client.query(`
      ALTER TABLE purchase_orders
        DROP COLUMN IF EXISTS issued_by_user_id,
        DROP COLUMN IF EXISTS issued_at
    `);
  },
};
