import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SVC-01 PART 04 — SERVICE Procurement Lineage Identity.
 *
 * Propagates the governed Service Catalog identity through the existing SERVICE
 * procurement lineage as additive, nullable, identity-only snapshots
 * (`docs/CR-BE-SVC-01_START_GOVERNANCE.md` §9):
 *
 *   Service Request → RFQ Line → Vendor Quotation Line → Award/PO Line
 *
 * Rules honored:
 *   - `source_service_id` is NULLABLE. Historical rows keep NULL and behave
 *     exactly as before. No backfill, no auto-mapping from historical strings.
 *   - SERVICE identity ONLY: a CHECK forbids a non-NULL `source_service_id` on
 *     MATERIAL rows (MATERIAL lineage is unchanged).
 *   - No item/UOM/quantity is introduced for SERVICE. The existing PRO-02 /
 *     R2P-01 SERVICE shape CHECKs are untouched — `source_service_id` is an
 *     identity snapshot, independent of the shape constraints.
 *   - Scope-FK precedent (`0313`/`0319`/`0322`): composite
 *     `(source_service_id, client_id)` where the table carries `client_id`
 *     (`rfq_lines`, `purchase_order_lines`); plain FK on `vendor_quotation_lines`
 *     (no `client_id` column — Client scope is inherited via the client-scoped
 *     `rfq_line_id` and the identity is snapshotted from a client-scoped line).
 */
export const migration0324AddServiceLineageIdentity: Migration = {
  id: '0324_add_service_lineage_identity',

  async up(client: PoolClient): Promise<void> {
    // --- rfq_lines: governed SERVICE identity snapshot (composite scope FK) ---
    await client.query(`
      ALTER TABLE rfq_lines
        ADD COLUMN source_service_id UUID
    `);
    await client.query(`
      ALTER TABLE rfq_lines
        ADD CONSTRAINT rfq_lines_service_catalog_scope_fk
          FOREIGN KEY (source_service_id, client_id)
          REFERENCES service_catalog (id, client_id)
    `);
    await client.query(`
      ALTER TABLE rfq_lines
        ADD CONSTRAINT rfq_lines_service_identity_mode_check
          CHECK (source_mode <> 'MATERIAL' OR source_service_id IS NULL)
    `);
    await client.query(`
      CREATE INDEX rfq_lines_source_service_idx
        ON rfq_lines (source_service_id)
        WHERE source_service_id IS NOT NULL
    `);

    // --- vendor_quotation_lines: governed SERVICE identity snapshot (plain FK) ---
    await client.query(`
      ALTER TABLE vendor_quotation_lines
        ADD COLUMN source_service_id UUID REFERENCES service_catalog (id)
    `);
    await client.query(`
      ALTER TABLE vendor_quotation_lines
        ADD CONSTRAINT vendor_quotation_lines_service_identity_mode_check
          CHECK (source_mode <> 'MATERIAL' OR source_service_id IS NULL)
    `);
    await client.query(`
      CREATE INDEX vendor_quotation_lines_source_service_idx
        ON vendor_quotation_lines (source_service_id)
        WHERE source_service_id IS NOT NULL
    `);

    // --- purchase_order_lines: governed SERVICE identity snapshot (composite FK) ---
    await client.query(`
      ALTER TABLE purchase_order_lines
        ADD COLUMN source_service_id UUID
    `);
    await client.query(`
      ALTER TABLE purchase_order_lines
        ADD CONSTRAINT purchase_order_lines_service_catalog_scope_fk
          FOREIGN KEY (source_service_id, client_id)
          REFERENCES service_catalog (id, client_id)
    `);
    await client.query(`
      ALTER TABLE purchase_order_lines
        ADD CONSTRAINT purchase_order_lines_service_identity_mode_check
          CHECK (
            request_line_type <> 'MATERIAL_REQUEST'
              OR source_service_id IS NULL
          )
    `);
    await client.query(`
      CREATE INDEX purchase_order_lines_source_service_idx
        ON purchase_order_lines (source_service_id)
        WHERE source_service_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    for (const table of [
      'rfq_lines',
      'vendor_quotation_lines',
      'purchase_order_lines',
    ]) {
      await client.query(
        `DROP INDEX IF EXISTS ${table}_source_service_idx`,
      );
    }
    await client.query(
      `ALTER TABLE purchase_order_lines
         DROP CONSTRAINT IF EXISTS purchase_order_lines_service_identity_mode_check`,
    );
    await client.query(
      `ALTER TABLE purchase_order_lines
         DROP CONSTRAINT IF EXISTS purchase_order_lines_service_catalog_scope_fk`,
    );
    await client.query(
      `ALTER TABLE purchase_order_lines
         DROP COLUMN IF EXISTS source_service_id`,
    );
    await client.query(
      `ALTER TABLE vendor_quotation_lines
         DROP CONSTRAINT IF EXISTS vendor_quotation_lines_service_identity_mode_check`,
    );
    await client.query(
      `ALTER TABLE vendor_quotation_lines
         DROP COLUMN IF EXISTS source_service_id`,
    );
    await client.query(
      `ALTER TABLE rfq_lines
         DROP CONSTRAINT IF EXISTS rfq_lines_service_identity_mode_check`,
    );
    await client.query(
      `ALTER TABLE rfq_lines
         DROP CONSTRAINT IF EXISTS rfq_lines_service_catalog_scope_fk`,
    );
    await client.query(
      `ALTER TABLE rfq_lines DROP COLUMN IF EXISTS source_service_id`,
    );
  },
};
