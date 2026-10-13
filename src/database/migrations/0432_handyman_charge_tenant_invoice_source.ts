import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Bounded CR-HM-13 -> BE-19D invoice bridge.
 *
 * One invoice is anchored to at most one Handyman execution scope and a
 * Handyman invoice contains only that scope's authoritative charge lines.
 * The existing payment/allocation ledger remains the sole funds authority;
 * invoice lines are source links, not copied money facts beyond the existing
 * immutable invoice snapshot.
 */
export const migration0432HandymanChargeTenantInvoiceSource: Migration = {
  id: '0432_handyman_charge_tenant_invoice_source',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE tenant_invoices
        ADD COLUMN handyman_execution_scope_id UUID
          REFERENCES handyman_execution_scopes (id);
      CREATE UNIQUE INDEX tenant_invoices_handyman_scope_unique
        ON tenant_invoices (handyman_execution_scope_id)
        WHERE handyman_execution_scope_id IS NOT NULL;

      ALTER TABLE tenant_invoice_lines
        ADD COLUMN handyman_charge_line_id UUID
          REFERENCES handyman_charge_lines (id),
        DROP CONSTRAINT tenant_invoice_lines_source_type_check,
        DROP CONSTRAINT tenant_invoice_lines_source_reference_check,
        DROP CONSTRAINT tenant_invoice_lines_type_reference_check,
        ADD CONSTRAINT tenant_invoice_lines_source_type_check
          CHECK (source_type IN ('TENANT_CHARGE', 'UTILITY_BILL', 'HANDYMAN_CHARGE')),
        ADD CONSTRAINT tenant_invoice_lines_source_reference_check CHECK (
          (tenant_charge_id IS NOT NULL)::int +
          (utility_bill_id IS NOT NULL)::int +
          (handyman_charge_line_id IS NOT NULL)::int = 1
        ),
        ADD CONSTRAINT tenant_invoice_lines_type_reference_check CHECK (
          (source_type = 'TENANT_CHARGE' AND tenant_charge_id IS NOT NULL)
          OR (source_type = 'UTILITY_BILL' AND utility_bill_id IS NOT NULL)
          OR (source_type = 'HANDYMAN_CHARGE' AND handyman_charge_line_id IS NOT NULL)
        );
      CREATE UNIQUE INDEX tenant_invoice_lines_handyman_charge_unique
        ON tenant_invoice_lines (handyman_charge_line_id)
        WHERE handyman_charge_line_id IS NOT NULL;
    `);

    await client.query(`
      CREATE FUNCTION tenant_invoice_handyman_scope_guard()
      RETURNS trigger AS $$
      DECLARE
        scope_client UUID;
        scope_tenant UUID;
        scope_building UUID;
        scope_space UUID;
        transaction_currency VARCHAR(3);
      BEGIN
        IF NEW.handyman_execution_scope_id IS NULL THEN
          IF TG_OP = 'UPDATE'
             AND OLD.handyman_execution_scope_id IS NOT NULL THEN
            RAISE EXCEPTION 'A Handyman invoice scope binding is immutable.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          -- Permit the one-time NULL -> scope binding performed while the
          -- invoice engine inserts its first Handyman source line. Once set,
          -- the scope identity cannot be changed or cleared.
          IF OLD.handyman_execution_scope_id IS NOT NULL
             AND NEW.handyman_execution_scope_id IS DISTINCT FROM OLD.handyman_execution_scope_id THEN
            RAISE EXCEPTION 'A Handyman invoice scope binding is immutable.'
              USING ERRCODE = '23514';
          END IF;
          -- A bound invoice may move through its existing DRAFT -> FINALIZED
          -- or DRAFT -> CANCELLED lifecycle. Only the initial binding is
          -- restricted to DRAFT; rejecting later status updates would make
          -- the supported invoice engine unable to finalize Handyman invoices.
          IF OLD.handyman_execution_scope_id IS NULL AND NEW.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'A Handyman execution scope may be bound only to a draft invoice.'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'A Handyman execution scope may be bound only to a draft invoice.'
            USING ERRCODE = '23514';
        END IF;
        SELECT es.client_id, es.tenant_company_id, es.building_id, es.space_id,
               tx.currency
          INTO scope_client, scope_tenant, scope_building, scope_space,
               transaction_currency
          FROM handyman_execution_scopes es
          JOIN handyman_customer_transactions tx
            ON tx.execution_scope_id = es.id
         WHERE es.id = NEW.handyman_execution_scope_id;
        IF scope_client IS NULL OR
           NEW.client_id IS DISTINCT FROM scope_client OR
           NEW.tenant_company_id IS DISTINCT FROM scope_tenant OR
           NEW.building_id IS DISTINCT FROM scope_building OR
           NEW.space_id IS DISTINCT FROM scope_space OR
           NEW.currency_code IS DISTINCT FROM transaction_currency THEN
          RAISE EXCEPTION 'Handyman invoice context and currency must match its execution scope.'
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM tenant_invoice_lines l
           WHERE l.invoice_id = NEW.id AND l.source_type <> 'HANDYMAN_CHARGE'
        ) THEN
          RAISE EXCEPTION 'Handyman invoices cannot contain mixed source types.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER tenant_invoice_handyman_scope_guard
        BEFORE INSERT OR UPDATE ON tenant_invoices
        FOR EACH ROW EXECUTE FUNCTION tenant_invoice_handyman_scope_guard();
    `);

    await client.query(`
      CREATE FUNCTION invoice_payment_status_handyman_derived_guard()
      RETURNS trigger AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM tenant_invoices
           WHERE id = NEW.invoice_id AND handyman_execution_scope_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Handyman invoice payment status is derived from confirmed ledger allocations.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER invoice_payment_status_handyman_derived_guard
        BEFORE INSERT OR UPDATE ON invoice_payment_status
        FOR EACH ROW EXECUTE FUNCTION invoice_payment_status_handyman_derived_guard();
    `);

    await client.query(`
      CREATE FUNCTION tenant_invoice_handyman_line_guard()
      RETURNS trigger AS $$
      DECLARE
        invoice_scope UUID;
        invoice_status TEXT;
        invoice_client UUID;
        invoice_tenant UUID;
        invoice_building UUID;
        invoice_space UUID;
        invoice_currency VARCHAR(3);
        line_client UUID;
        line_transaction UUID;
        line_scope UUID;
        line_tenant UUID;
        line_building UUID;
        line_space UUID;
        line_currency VARCHAR(3);
        line_amount NUMERIC;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          SELECT handyman_execution_scope_id INTO invoice_scope
            FROM tenant_invoices WHERE id = OLD.invoice_id FOR UPDATE;
          IF invoice_scope IS NOT NULL THEN
            RAISE EXCEPTION 'Handyman invoice source lines cannot be deleted.'
              USING ERRCODE = '23514';
          END IF;
          RETURN OLD;
        END IF;
        SELECT handyman_execution_scope_id, status, client_id,
               tenant_company_id, building_id, space_id, currency_code
          INTO invoice_scope, invoice_status, invoice_client, invoice_tenant,
               invoice_building, invoice_space, invoice_currency
          FROM tenant_invoices WHERE id = NEW.invoice_id FOR UPDATE;
        IF invoice_status IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'Only a draft invoice can receive source lines.'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.source_type <> 'HANDYMAN_CHARGE' THEN
          IF invoice_scope IS NOT NULL THEN
            RAISE EXCEPTION 'Handyman invoices cannot contain mixed source types.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;
        SELECT cl.client_id, cl.transaction_id, tx.execution_scope_id,
               es.tenant_company_id, es.building_id, es.space_id,
               cl.currency, cl.amount
          INTO line_client, line_transaction, line_scope,
               line_tenant, line_building, line_space, line_currency,
               line_amount
          FROM handyman_charge_lines cl
          JOIN handyman_customer_transactions tx ON tx.id = cl.transaction_id
          JOIN handyman_execution_scopes es ON es.id = tx.execution_scope_id
         WHERE cl.id = NEW.handyman_charge_line_id;
        IF line_scope IS NULL OR invoice_scope IS DISTINCT FROM line_scope OR
           invoice_client IS DISTINCT FROM line_client OR
           invoice_tenant IS DISTINCT FROM line_tenant OR
           invoice_building IS DISTINCT FROM line_building OR
           invoice_space IS DISTINCT FROM line_space OR
           invoice_currency IS DISTINCT FROM line_currency OR
           NEW.amount_snapshot IS DISTINCT FROM line_amount OR
           NEW.currency_code IS DISTINCT FROM line_currency THEN
          RAISE EXCEPTION 'Handyman invoice line must match its source charge and execution scope.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER tenant_invoice_handyman_line_guard
        BEFORE INSERT OR UPDATE OR DELETE ON tenant_invoice_lines
        FOR EACH ROW EXECUTE FUNCTION tenant_invoice_handyman_line_guard();
    `);

    await client.query(`
      CREATE FUNCTION handyman_invoice_allocation_guard()
      RETURNS trigger AS $$
      DECLARE
        allocation_scope UUID;
        invoice_id UUID;
        invoice_status TEXT;
        source_linked BOOLEAN;
      BEGIN
        SELECT tx.execution_scope_id
          INTO allocation_scope
          FROM handyman_charge_lines cl
          JOIN handyman_customer_transactions tx ON tx.id = cl.transaction_id
         WHERE cl.id = NEW.charge_line_id;
        IF allocation_scope IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT i.id, i.status,
               EXISTS (
                 SELECT 1 FROM tenant_invoice_lines il
                  WHERE il.invoice_id = i.id
                    AND il.handyman_charge_line_id = NEW.charge_line_id
               )
          INTO invoice_id, invoice_status, source_linked
          FROM tenant_invoices i
         WHERE i.handyman_execution_scope_id = allocation_scope
         FOR SHARE;
        IF invoice_id IS NOT NULL AND
           (invoice_status IS DISTINCT FROM 'FINALIZED' OR source_linked IS DISTINCT FROM TRUE) THEN
          RAISE EXCEPTION 'Handyman allocations for an invoiced scope must target a linked charge line on its finalized invoice.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_invoice_allocation_guard
        BEFORE INSERT ON handyman_payment_allocations
        FOR EACH ROW EXECUTE FUNCTION handyman_invoice_allocation_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_invoice_allocation_guard ON handyman_payment_allocations;
      DROP FUNCTION IF EXISTS handyman_invoice_allocation_guard();
      DROP TRIGGER IF EXISTS invoice_payment_status_handyman_derived_guard ON invoice_payment_status;
      DROP FUNCTION IF EXISTS invoice_payment_status_handyman_derived_guard();
      DROP TRIGGER IF EXISTS tenant_invoice_handyman_line_guard ON tenant_invoice_lines;
      DROP FUNCTION IF EXISTS tenant_invoice_handyman_line_guard();
      DROP TRIGGER IF EXISTS tenant_invoice_handyman_scope_guard ON tenant_invoices;
      DROP FUNCTION IF EXISTS tenant_invoice_handyman_scope_guard();
      DROP INDEX IF EXISTS tenant_invoice_lines_handyman_charge_unique;
      DROP INDEX IF EXISTS tenant_invoices_handyman_scope_unique;
      ALTER TABLE tenant_invoice_lines
        DROP CONSTRAINT IF EXISTS tenant_invoice_lines_type_reference_check,
        DROP CONSTRAINT IF EXISTS tenant_invoice_lines_source_reference_check,
        DROP CONSTRAINT IF EXISTS tenant_invoice_lines_source_type_check,
        DROP COLUMN IF EXISTS handyman_charge_line_id,
        ADD CONSTRAINT tenant_invoice_lines_source_type_check
          CHECK (source_type IN ('TENANT_CHARGE', 'UTILITY_BILL')),
        ADD CONSTRAINT tenant_invoice_lines_source_reference_check CHECK (
          (tenant_charge_id IS NOT NULL)::int + (utility_bill_id IS NOT NULL)::int = 1
        ),
        ADD CONSTRAINT tenant_invoice_lines_type_reference_check CHECK (
          (source_type = 'TENANT_CHARGE' AND tenant_charge_id IS NOT NULL)
          OR (source_type = 'UTILITY_BILL' AND utility_bill_id IS NOT NULL)
        );
      ALTER TABLE tenant_invoices DROP COLUMN IF EXISTS handyman_execution_scope_id;
    `);
  },
};
