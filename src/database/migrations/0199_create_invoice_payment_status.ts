import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-19E — Payment Status.
 *
 * Settlement-state tracking for an existing BE-19D Invoice only. Invoice total
 * remains authoritative; no Invoice amount is changed here. This is not a
 * payment transaction, gateway, banking, reconciliation, receipt, ledger, or
 * accounting engine.
 */
export const migration0199CreateInvoicePaymentStatus: Migration = {
  id: '0199_create_invoice_payment_status',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE invoice_payment_status (
        id                  UUID PRIMARY KEY,
        invoice_id          UUID NOT NULL UNIQUE REFERENCES tenant_invoices (id),
        client_id           UUID NOT NULL REFERENCES clients (id),
        tenant_company_id   UUID NOT NULL REFERENCES tenant_companies (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        payment_status      TEXT NOT NULL,
        paid_amount         NUMERIC NOT NULL DEFAULT 0,
        outstanding_amount  NUMERIC NOT NULL,
        paid_at             TIMESTAMPTZ,
        payment_reference   TEXT,
        notes               TEXT,
        recorded_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT invoice_payment_status_status_check
          CHECK (payment_status IN
            ('UNPAID','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED')),
        CONSTRAINT invoice_payment_status_amount_check
          CHECK (paid_amount >= 0 AND outstanding_amount >= 0),
        CONSTRAINT invoice_payment_status_paid_at_check
          CHECK (paid_amount > 0 OR paid_at IS NULL)
      )
    `);
    await client.query(`
      CREATE INDEX invoice_payment_status_tenant_idx
        ON invoice_payment_status (tenant_company_id, payment_status);
      CREATE INDEX invoice_payment_status_building_idx
        ON invoice_payment_status (building_id, payment_status);
      CREATE INDEX invoice_payment_status_status_idx
        ON invoice_payment_status (payment_status, updated_at DESC)
    `);

    await client.query(`
      CREATE TABLE invoice_payment_status_history (
        id                        UUID PRIMARY KEY,
        invoice_payment_status_id UUID NOT NULL REFERENCES invoice_payment_status (id),
        action                    TEXT NOT NULL,
        payment_status            TEXT NOT NULL,
        paid_amount               NUMERIC NOT NULL,
        outstanding_amount        NUMERIC NOT NULL,
        paid_at                   TIMESTAMPTZ,
        payment_reference         TEXT,
        notes                     TEXT,
        changed_by_user_id        UUID NOT NULL REFERENCES users (id),
        changed_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT invoice_payment_status_history_action_check
          CHECK (action IN ('RECORDED','UPDATED','STATUS_REFRESHED'))
      )
    `);
    await client.query(`
      CREATE INDEX invoice_payment_status_history_record_idx
        ON invoice_payment_status_history
          (invoice_payment_status_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS invoice_payment_status_history');
    await client.query('DROP TABLE IF EXISTS invoice_payment_status');
  },
};
