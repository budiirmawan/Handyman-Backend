import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-R2P-01 PART 06 — PO / SPK → Vendor Invoice commercial linkage.
 *
 * Closes the commercial half of the R2P chain:
 *
 *   Request → Vendor → ISSUED PO → ACTIVE/COMPLETED SPK → Work Order
 *           → BAST → **Vendor Invoice** → Settlement
 *
 * Strictly ADDITIVE to the existing CR-BE-COM-02 `vendor_invoices`. No
 * parallel invoice domain is created: the existing invoice remains the single
 * payable authority, and its lifecycle (DRAFT → FINALIZED → CANCELLED),
 * amount authority, verification, payment status, BAST gate and settlement
 * readiness are all untouched.
 *
 * Two columns are added, both NULLABLE so every pre-existing invoice stays
 * valid and its BAST / Work Order / Vendor Work linkage is preserved:
 *
 *   purchase_order_id — the ISSUED PO being invoiced against
 *   work_contract_id  — the SPK under which the work was executed
 *
 * Integrity is structural rather than conventional:
 *
 *  1. `vendor_invoices_po_scope_fk` — a COMPOSITE FK onto
 *     `purchase_orders (id, client_id, building_id, vendor_id)`. Because the
 *     invoice's own client/building/vendor participate in the key, an invoice
 *     whose Client, Building or Vendor disagrees with its PO cannot be
 *     represented.
 *
 *  2. `vendor_invoices_spk_scope_fk` — a COMPOSITE FK onto
 *     `work_contracts (id, client_id, building_id, vendor_id,
 *     purchase_order_id)`. This single key simultaneously pins the SPK to the
 *     invoice's scope AND to the invoice's own purchase_order_id, so "the SPK
 *     must belong to that PO" is a database guarantee.
 *
 *  3. `vendor_invoices_spk_requires_po_check` — an SPK reference is only
 *     meaningful alongside its PO, so the SPK cannot be linked alone.
 *
 * Under MATCH SIMPLE both FKs are skipped when their reference is NULL, so
 * legacy invoices are entirely unaffected. Lifecycle eligibility is enforced
 * by the service at creation time: the PO must be ISSUED and an optional SPK
 * must be ACTIVE or COMPLETED. Status is not duplicated on this table.
 */
export const migration0274AddVendorInvoiceProcurementLinkage: Migration = {
  id: '0274_add_vendor_invoice_procurement_linkage',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE vendor_invoices
        ADD COLUMN purchase_order_id UUID REFERENCES purchase_orders (id),
        ADD COLUMN work_contract_id  UUID REFERENCES work_contracts (id)
    `);

    // An SPK is executed under a PO; referencing it without that PO would
    // leave the commercial chain half-described.
    await client.query(`
      ALTER TABLE vendor_invoices
        ADD CONSTRAINT vendor_invoices_spk_requires_po_check
          CHECK (work_contract_id IS NULL OR purchase_order_id IS NOT NULL)
    `);

    // Client / Building / Vendor can never drift from the linked PO.
    // Reuses `purchase_orders_scope_unique`, introduced in 0272.
    await client.query(`
      ALTER TABLE vendor_invoices
        ADD CONSTRAINT vendor_invoices_po_scope_fk
          FOREIGN KEY (purchase_order_id, client_id, building_id, vendor_id)
          REFERENCES purchase_orders (id, client_id, building_id, vendor_id)
    `);

    // The SPK must match the invoice scope AND belong to the invoice's PO.
    // Reuses `work_contracts_chain_scope_unique`, introduced in 0273.
    await client.query(`
      ALTER TABLE vendor_invoices
        ADD CONSTRAINT vendor_invoices_spk_scope_fk
          FOREIGN KEY (work_contract_id, client_id, building_id,
                       vendor_id, purchase_order_id)
          REFERENCES work_contracts (id, client_id, building_id,
                                     vendor_id, purchase_order_id)
    `);

    await client.query(`
      CREATE INDEX vendor_invoices_purchase_order_idx
        ON vendor_invoices (purchase_order_id)
        WHERE purchase_order_id IS NOT NULL;
      CREATE INDEX vendor_invoices_work_contract_idx
        ON vendor_invoices (work_contract_id)
        WHERE work_contract_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Dropping the columns removes the procurement linkage while leaving
    // every pre-PART-06 invoice — and its BAST / Work Order / payment state —
    // exactly as it was.
    await client.query(`
      DROP INDEX IF EXISTS vendor_invoices_purchase_order_idx;
      DROP INDEX IF EXISTS vendor_invoices_work_contract_idx
    `);
    await client.query(`
      ALTER TABLE vendor_invoices
        DROP CONSTRAINT IF EXISTS vendor_invoices_spk_scope_fk,
        DROP CONSTRAINT IF EXISTS vendor_invoices_po_scope_fk,
        DROP CONSTRAINT IF EXISTS vendor_invoices_spk_requires_po_check,
        DROP COLUMN IF EXISTS work_contract_id,
        DROP COLUMN IF EXISTS purchase_order_id
    `);
  },
};
