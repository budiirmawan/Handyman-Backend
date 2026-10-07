import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-R2P-01 PART 05 — SPK → PO / Vendor / Work Order Binding.
 *
 * Completes the authoritative R2P execution chain:
 *
 *   Request → selected Vendor → ISSUED PO → ACTIVE SPK → Work Order
 *
 * This migration is strictly ADDITIVE to the existing BE-17H
 * `work_order_procurement_bindings`. It does NOT create a parallel SPK ↔ WO
 * binding table: the existing binding row remains the single, authoritative
 * procurement binding for a Work Order, and `wo_procurement_work_order_unique`
 * continues to guarantee exactly one binding per Work Order.
 *
 * Three columns are added, all NULLABLE so every pre-existing binding stays
 * valid and its Purchase Request / Material Request / Service Request linkage
 * is preserved untouched:
 *
 *   work_contract_id  — the ACTIVE SPK authorizing this Work Order
 *   purchase_order_id — the ISSUED PO behind that SPK
 *   vendor_id         — the committed Vendor executing the work
 *
 * Integrity is structural rather than conventional:
 *
 *  1. `wo_procurement_spk_context_check` — the three columns arrive together.
 *     A binding either carries no SPK context at all (legacy / request-only
 *     binding) or carries the complete, coherent set.
 *
 *  2. `wo_procurement_spk_scope_fk` — a COMPOSITE foreign key onto
 *     `work_contracts (id, client_id, building_id, vendor_id,
 *     purchase_order_id)`. Because the binding's own `client_id` /
 *     `building_id` participate in that key, it is impossible to store a
 *     binding whose Client, Building, Vendor or PO disagrees with its SPK —
 *     the mismatch cases this CR must reject cannot even be represented.
 *     Under MATCH SIMPLE the FK is skipped when `work_contract_id` is NULL,
 *     so legacy rows are unaffected.
 *
 * PO lifecycle, SPK lifecycle, MR/SR quantity authority, receiving/inventory,
 * BAST closure and invoice/payment/settlement are all untouched.
 */
export const migration0273AddWoProcurementSpkBinding: Migration = {
  id: '0273_add_wo_procurement_spk_binding',

  async up(client: PoolClient): Promise<void> {
    // Composite uniqueness on the SPK's authoritative context — the target of
    // the binding's composite FK below. `work_contracts.id` is already the
    // primary key, so this adds no new row-level restriction; it only exposes
    // the tuple as a referenceable key.
    await client.query(`
      ALTER TABLE work_contracts
        ADD CONSTRAINT work_contracts_chain_scope_unique
          UNIQUE (id, client_id, building_id, vendor_id, purchase_order_id)
    `);

    await client.query(`
      ALTER TABLE work_order_procurement_bindings
        ADD COLUMN work_contract_id  UUID REFERENCES work_contracts (id),
        ADD COLUMN purchase_order_id UUID REFERENCES purchase_orders (id),
        ADD COLUMN vendor_id         UUID REFERENCES vendors (id)
    `);

    // The SPK context is all-or-nothing: carrying a Work Contract without its
    // PO and Vendor would leave the chain half-described.
    await client.query(`
      ALTER TABLE work_order_procurement_bindings
        ADD CONSTRAINT wo_procurement_spk_context_check
          CHECK (
            (work_contract_id IS NULL
              AND purchase_order_id IS NULL AND vendor_id IS NULL)
            OR (work_contract_id IS NOT NULL
              AND purchase_order_id IS NOT NULL AND vendor_id IS NOT NULL)
          )
    `);

    // Client / Building / Vendor / PO can never drift from the bound SPK.
    await client.query(`
      ALTER TABLE work_order_procurement_bindings
        ADD CONSTRAINT wo_procurement_spk_scope_fk
          FOREIGN KEY (work_contract_id, client_id, building_id,
                       vendor_id, purchase_order_id)
          REFERENCES work_contracts (id, client_id, building_id,
                                     vendor_id, purchase_order_id)
    `);

    await client.query(`
      CREATE INDEX wo_procurement_work_contract_idx
        ON work_order_procurement_bindings (work_contract_id)
        WHERE work_contract_id IS NOT NULL;
      CREATE INDEX wo_procurement_purchase_order_idx
        ON work_order_procurement_bindings (purchase_order_id)
        WHERE purchase_order_id IS NOT NULL;
      CREATE INDEX wo_procurement_vendor_idx
        ON work_order_procurement_bindings (vendor_id)
        WHERE vendor_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Dropping the columns removes the SPK linkage while leaving every
    // pre-PART-05 binding — and its Purchase/Material/Service Request
    // linkage — exactly as it was.
    await client.query(`
      DROP INDEX IF EXISTS wo_procurement_work_contract_idx;
      DROP INDEX IF EXISTS wo_procurement_purchase_order_idx;
      DROP INDEX IF EXISTS wo_procurement_vendor_idx
    `);
    await client.query(`
      ALTER TABLE work_order_procurement_bindings
        DROP CONSTRAINT IF EXISTS wo_procurement_spk_scope_fk,
        DROP CONSTRAINT IF EXISTS wo_procurement_spk_context_check,
        DROP COLUMN IF EXISTS vendor_id,
        DROP COLUMN IF EXISTS purchase_order_id,
        DROP COLUMN IF EXISTS work_contract_id
    `);
    // Dropped last: the composite unique was only needed as the FK target.
    await client.query(`
      ALTER TABLE work_contracts
        DROP CONSTRAINT IF EXISTS work_contracts_chain_scope_unique
    `);
  },
};
