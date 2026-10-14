import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-AUTHORITY-01 P0-C — Material & Purchasing Lifecycle
 *
 * Governed lifecycle:
 *   REQUEST -> APPROVAL -> ISSUED | PURCHASED -> USAGE -> RETURN -> RECONCILIATION
 *
 * Strictly separates:
 *   1. Operational material movement (requested, approved, issued, purchased, used, returned)
 *   2. Actual supplier purchasing expense (supplier, purchase ref, actual unit price, total expense, currency, purchase date, expenditure ref, receipt evidence)
 *   3. Worker advance / reimbursement payable (funding source, cash advance ref, reimbursement payable amount, payee, reconciliation status)
 *   4. Tenant invoice charge eligibility (eligible flag, eligible used qty, tenant_invoiced = FALSE)
 */
export const migration0436CreateHandymanMaterialPurchasing: Migration = {
  id: '0436_create_handyman_material_purchasing',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_material_purchase_records (
        id                             UUID PRIMARY KEY,
        client_id                      UUID NOT NULL REFERENCES clients (id),
        execution_scope_id             UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        handyman_request_id            UUID NOT NULL,
        tenant_company_id              UUID NOT NULL REFERENCES tenant_companies (id),
        building_id                    UUID NOT NULL REFERENCES buildings (id),
        material_execution_line_id     UUID REFERENCES handyman_material_execution_lines (id),
        source_item_id                 UUID,
        item_name                      TEXT NOT NULL
          CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 250),
        uom_id                         UUID NOT NULL REFERENCES units_of_measure (id),
        uom_code                       TEXT,
        funding_source                 TEXT NOT NULL
          CHECK (funding_source IN (
            'PETTY_CASH',
            'CASH_ADVANCE',
            'REIMBURSEMENT',
            'COMPANY_DIRECT',
            'WAREHOUSE_STOCK'
          )),
        status                         TEXT NOT NULL
          CHECK (status IN (
            'REQUEST',
            'APPROVAL',
            'ISSUED',
            'PURCHASED',
            'USAGE',
            'RETURN',
            'RECONCILIATION'
          )),
        requested_quantity             NUMERIC(14, 3) NOT NULL
          CHECK (requested_quantity > 0),
        approved_quantity              NUMERIC(14, 3) NOT NULL DEFAULT 0
          CHECK (approved_quantity >= 0),
        issued_quantity                NUMERIC(14, 3) NOT NULL DEFAULT 0
          CHECK (issued_quantity >= 0),
        purchased_quantity             NUMERIC(14, 3) NOT NULL DEFAULT 0
          CHECK (purchased_quantity >= 0),
        used_quantity                  NUMERIC(14, 3) NOT NULL DEFAULT 0
          CHECK (used_quantity >= 0),
        returned_quantity              NUMERIC(14, 3) NOT NULL DEFAULT 0
          CHECK (returned_quantity >= 0),
        return_destination             TEXT
          CHECK (return_destination IS NULL OR return_destination IN (
            'WAREHOUSE', 'SUPPLIER_RETURN', 'COMPANY_CUSTODY'
          )),
        supplier_name                  TEXT,
        supplier_reference             TEXT,
        purchase_reference             TEXT,
        purchase_date                  TIMESTAMPTZ,
        currency                       VARCHAR(3) NOT NULL DEFAULT 'IDR'
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY'
          )),
        approved_max_unit_price        NUMERIC(18, 2)
          CHECK (approved_max_unit_price IS NULL OR approved_max_unit_price >= 0),
        actual_unit_price              NUMERIC(18, 2)
          CHECK (actual_unit_price IS NULL OR actual_unit_price >= 0),
        actual_total_expense_amount    NUMERIC(18, 2) NOT NULL DEFAULT 0
          CHECK (actual_total_expense_amount >= 0),
        net_used_expense_amount        NUMERIC(18, 2) NOT NULL DEFAULT 0
          CHECK (net_used_expense_amount >= 0),
        approval_reference             TEXT,
        expenditure_reference          TEXT,
        cash_advance_reference         TEXT,
        receipt_evidence_reference     TEXT,
        latest_evidence_reference      TEXT NOT NULL
          CHECK (char_length(btrim(latest_evidence_reference)) BETWEEN 1 AND 500),
        reimbursement_payable_amount   NUMERIC(18, 2) NOT NULL DEFAULT 0
          CHECK (reimbursement_payable_amount >= 0),
        reimbursement_payee_user_id    UUID REFERENCES users (id),
        reimbursement_status           TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
          CHECK (reimbursement_status IN (
            'NOT_APPLICABLE',
            'PENDING_RECONCILIATION',
            'RECONCILED_PAYABLE'
          )),
        tenant_charge_eligible         BOOLEAN NOT NULL DEFAULT FALSE,
        tenant_charge_eligible_qty     NUMERIC(14, 3) NOT NULL DEFAULT 0
          CHECK (tenant_charge_eligible_qty >= 0),
        tenant_invoiced                BOOLEAN NOT NULL DEFAULT FALSE
          CHECK (tenant_invoiced = FALSE),
        requested_by_user_id           UUID NOT NULL REFERENCES users (id),
        approved_by_user_id            UUID REFERENCES users (id),
        reconciled_by_user_id          UUID REFERENCES users (id),
        reconciled_at                  TIMESTAMPTZ,
        create_idempotency_key         TEXT NOT NULL
          CHECK (char_length(btrim(create_idempotency_key)) BETWEEN 1 AND 128),
        version                        INTEGER NOT NULL DEFAULT 1
          CHECK (version >= 1),
        created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_material_purchase_create_idem_unique
          UNIQUE (execution_scope_id, create_idempotency_key),
        CONSTRAINT handyman_material_purchase_quantity_balance_check
          CHECK (used_quantity + returned_quantity <= issued_quantity + purchased_quantity),
        CONSTRAINT handyman_material_purchase_reconciled_balance_check
          CHECK (
            status <> 'RECONCILIATION'
            OR (
              used_quantity > 0
              AND used_quantity + returned_quantity = issued_quantity + purchased_quantity
            )
          )
      );

      CREATE INDEX handyman_material_purchase_records_scope_idx
        ON handyman_material_purchase_records (execution_scope_id, created_at ASC, id ASC);
    `);

    await client.query(`
      CREATE TABLE handyman_material_purchase_events (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        purchase_record_id  UUID NOT NULL REFERENCES handyman_material_purchase_records (id),
        execution_scope_id  UUID NOT NULL REFERENCES handyman_execution_scopes (id),
        event_type          TEXT NOT NULL
          CHECK (event_type IN (
            'REQUEST',
            'APPROVAL',
            'ISSUED',
            'PURCHASED',
            'USAGE',
            'RETURN',
            'RECONCILIATION'
          )),
        from_status         TEXT,
        to_status           TEXT NOT NULL,
        actor_user_id       UUID NOT NULL REFERENCES users (id),
        actor_role          TEXT NOT NULL
          CHECK (actor_role IN ('PIC_PEKERJAAN', 'OPERATIONS_MANAGER')),
        quantity_delta      NUMERIC(14, 3) NOT NULL DEFAULT 0,
        evidence_reference  TEXT NOT NULL
          CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500),
        notes               TEXT,
        idempotency_key     TEXT NOT NULL
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_material_purchase_events_idem_unique
          UNIQUE (purchase_record_id, event_type, idempotency_key)
      );

      CREATE INDEX handyman_material_purchase_events_rec_idx
        ON handyman_material_purchase_events (purchase_record_id, occurred_at ASC, id ASC);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_material_purchase_events_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman material purchase events are append-only'
          USING ERRCODE = '23514';
      END;
      $$;

      CREATE TRIGGER handyman_material_purchase_events_immutable_trg
        BEFORE UPDATE OR DELETE ON handyman_material_purchase_events
        FOR EACH ROW EXECUTE FUNCTION handyman_material_purchase_events_immutable();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_material_purchase_events_immutable_trg
        ON handyman_material_purchase_events;
      DROP FUNCTION IF EXISTS handyman_material_purchase_events_immutable();
      DROP TABLE IF EXISTS handyman_material_purchase_events;
      DROP TABLE IF EXISTS handyman_material_purchase_records;
    `);
  },
};
