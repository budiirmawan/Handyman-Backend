import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-FIN-01 PART 03 — Typed Operational Cost Source Binding.
 *
 * This table stores explicit lineage only. It deliberately stores no source
 * amount, source status snapshot, commitment, actual, variance, payment, or
 * accounting value. Existing source tables remain authoritative.
 *
 * Every row carries exactly one typed source reference. Source eligibility,
 * scope, currency compatibility, and cross-source overlap are additionally
 * enforced by the Operational Finance service because the existing source
 * tables do not share one polymorphic parent key.
 */
export const migration0284CreateOperationalBudgetSourceBindings: Migration = {
  id: '0284_create_operational_budget_source_bindings',

  async up(client: PoolClient): Promise<void> {
    // Composite keys let the binding prove that its stored denormalised
    // Client/Building context belongs to the referenced Finance records.
    await client.query(`
      ALTER TABLE operational_budgets
        ADD CONSTRAINT operational_budgets_scope_unique
          UNIQUE (id, client_id, building_id)
    `);
    await client.query(`
      ALTER TABLE operational_budget_categories
        ADD CONSTRAINT operational_budget_categories_budget_unique
          UNIQUE (id, budget_id)
    `);

    await client.query(`
      CREATE TABLE operational_budget_source_bindings (
        id                            UUID PRIMARY KEY,
        budget_id                     UUID NOT NULL,
        budget_category_id            UUID NOT NULL,
        client_id                     UUID NOT NULL REFERENCES clients (id),
        building_id                   UUID NOT NULL REFERENCES buildings (id),
        source_type                   TEXT NOT NULL,
        basic_expense_id              UUID REFERENCES basic_expenses (id),
        vendor_service_cost_id        UUID REFERENCES vendor_service_costs (id),
        vendor_invoice_id             UUID REFERENCES vendor_invoices (id),
        purchase_order_id             UUID REFERENCES purchase_orders (id),
        purchase_order_line_id        UUID REFERENCES purchase_order_lines (id),
        work_order_material_usage_id  UUID REFERENCES inventory_work_order_material_usages (id),
        currency_status               TEXT NOT NULL,
        status                        TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id            UUID NOT NULL REFERENCES users (id),
        removed_by_user_id            UUID REFERENCES users (id),
        removed_at                    TIMESTAMPTZ,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT operational_budget_source_binding_scope_fk
          FOREIGN KEY (budget_id, client_id, building_id)
          REFERENCES operational_budgets (id, client_id, building_id),
        CONSTRAINT operational_budget_source_binding_category_fk
          FOREIGN KEY (budget_category_id, budget_id)
          REFERENCES operational_budget_categories (id, budget_id),
        CONSTRAINT operational_budget_source_binding_type_check
          CHECK (source_type IN (
            'BASIC_EXPENSE', 'VENDOR_SERVICE_COST', 'VENDOR_INVOICE',
            'PURCHASE_ORDER', 'PO_LINE', 'WORK_ORDER_MATERIAL'
          )),
        CONSTRAINT operational_budget_source_binding_one_source_check
          CHECK (
            (basic_expense_id IS NOT NULL)::int
            + (vendor_service_cost_id IS NOT NULL)::int
            + (vendor_invoice_id IS NOT NULL)::int
            + (purchase_order_id IS NOT NULL)::int
            + (purchase_order_line_id IS NOT NULL)::int
            + (work_order_material_usage_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT operational_budget_source_binding_type_reference_check
          CHECK (
            (source_type = 'BASIC_EXPENSE' AND basic_expense_id IS NOT NULL
              AND vendor_service_cost_id IS NULL AND vendor_invoice_id IS NULL
              AND purchase_order_id IS NULL AND purchase_order_line_id IS NULL
              AND work_order_material_usage_id IS NULL)
            OR (source_type = 'VENDOR_SERVICE_COST' AND vendor_service_cost_id IS NOT NULL
              AND basic_expense_id IS NULL AND vendor_invoice_id IS NULL
              AND purchase_order_id IS NULL AND purchase_order_line_id IS NULL
              AND work_order_material_usage_id IS NULL)
            OR (source_type = 'VENDOR_INVOICE' AND vendor_invoice_id IS NOT NULL
              AND basic_expense_id IS NULL AND vendor_service_cost_id IS NULL
              AND purchase_order_id IS NULL AND purchase_order_line_id IS NULL
              AND work_order_material_usage_id IS NULL)
            OR (source_type = 'PURCHASE_ORDER' AND purchase_order_id IS NOT NULL
              AND basic_expense_id IS NULL AND vendor_service_cost_id IS NULL
              AND vendor_invoice_id IS NULL AND purchase_order_line_id IS NULL
              AND work_order_material_usage_id IS NULL)
            OR (source_type = 'PO_LINE' AND purchase_order_line_id IS NOT NULL
              AND basic_expense_id IS NULL AND vendor_service_cost_id IS NULL
              AND vendor_invoice_id IS NULL AND purchase_order_id IS NULL
              AND work_order_material_usage_id IS NULL)
            OR (source_type = 'WORK_ORDER_MATERIAL'
              AND work_order_material_usage_id IS NOT NULL
              AND basic_expense_id IS NULL AND vendor_service_cost_id IS NULL
              AND vendor_invoice_id IS NULL AND purchase_order_id IS NULL
              AND purchase_order_line_id IS NULL)
          ),
        CONSTRAINT operational_budget_source_binding_currency_status_check
          CHECK (currency_status IN ('MATCHED', 'MISSING')),
        CONSTRAINT operational_budget_source_binding_status_check
          CHECK (status IN ('ACTIVE', 'REMOVED')),
        CONSTRAINT operational_budget_source_binding_lifecycle_check
          CHECK (
            (status = 'ACTIVE' AND removed_by_user_id IS NULL AND removed_at IS NULL)
            OR (status = 'REMOVED' AND removed_by_user_id IS NOT NULL AND removed_at IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX operational_budget_source_bindings_budget_idx
        ON operational_budget_source_bindings (budget_id, status, created_at);
      CREATE INDEX operational_budget_source_bindings_category_idx
        ON operational_budget_source_bindings (budget_category_id, status);
      CREATE INDEX operational_budget_source_bindings_client_building_idx
        ON operational_budget_source_bindings (client_id, building_id, status);
      CREATE INDEX operational_budget_source_bindings_currency_idx
        ON operational_budget_source_bindings (currency_status, status)
    `);

    // An authoritative source may be actively bound only once. Removed
    // history remains queryable and does not permit duplicate active rows.
    await client.query(`
      CREATE UNIQUE INDEX operational_budget_source_binding_basic_expense_unique
        ON operational_budget_source_bindings (basic_expense_id)
        WHERE status = 'ACTIVE' AND source_type = 'BASIC_EXPENSE';
      CREATE UNIQUE INDEX operational_budget_source_binding_vendor_cost_unique
        ON operational_budget_source_bindings (vendor_service_cost_id)
        WHERE status = 'ACTIVE' AND source_type = 'VENDOR_SERVICE_COST';
      CREATE UNIQUE INDEX operational_budget_source_binding_vendor_invoice_unique
        ON operational_budget_source_bindings (vendor_invoice_id)
        WHERE status = 'ACTIVE' AND source_type = 'VENDOR_INVOICE';
      CREATE UNIQUE INDEX operational_budget_source_binding_purchase_order_unique
        ON operational_budget_source_bindings (purchase_order_id)
        WHERE status = 'ACTIVE' AND source_type = 'PURCHASE_ORDER';
      CREATE UNIQUE INDEX operational_budget_source_binding_po_line_unique
        ON operational_budget_source_bindings (purchase_order_line_id)
        WHERE status = 'ACTIVE' AND source_type = 'PO_LINE';
      CREATE UNIQUE INDEX operational_budget_source_binding_material_unique
        ON operational_budget_source_bindings (work_order_material_usage_id)
        WHERE status = 'ACTIVE' AND source_type = 'WORK_ORDER_MATERIAL'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS operational_budget_source_bindings');
    await client.query(`
      ALTER TABLE operational_budget_categories
        DROP CONSTRAINT IF EXISTS operational_budget_categories_budget_unique
    `);
    await client.query(`
      ALTER TABLE operational_budgets
        DROP CONSTRAINT IF EXISTS operational_budgets_scope_unique
    `);
  },
};
