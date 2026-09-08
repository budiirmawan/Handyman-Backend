import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-19F — Payment Receipt.
 *
 * A Receipt confirms an amount already represented by BE-19E Payment Status.
 * It references that settlement context and its BE-19D Invoice; it does not
 * execute payments, modify Invoice totals, reconcile banks, or create ledger
 * entries. Issued rows are immutable except for the explicit ISSUED → VOID
 * lifecycle transition.
 */
export const migration0200CreatePaymentReceipts: Migration = {
  id: '0200_create_payment_receipts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE payment_receipts (
        id                        UUID PRIMARY KEY,
        receipt_number            TEXT NOT NULL,
        invoice_id                UUID NOT NULL REFERENCES tenant_invoices (id),
        invoice_payment_status_id UUID NOT NULL REFERENCES invoice_payment_status (id),
        client_id                 UUID NOT NULL REFERENCES clients (id),
        tenant_company_id         UUID NOT NULL REFERENCES tenant_companies (id),
        building_id               UUID NOT NULL REFERENCES buildings (id),
        received_amount           NUMERIC NOT NULL,
        received_at               TIMESTAMPTZ NOT NULL,
        payment_reference         TEXT,
        payment_method            TEXT,
        status                    TEXT NOT NULL DEFAULT 'ISSUED',
        notes                     TEXT,
        issued_by_user_id         UUID NOT NULL REFERENCES users (id),
        voided_at                 TIMESTAMPTZ,
        voided_by_user_id         UUID REFERENCES users (id),
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT payment_receipts_number_unique UNIQUE (client_id, receipt_number),
        CONSTRAINT payment_receipts_amount_check CHECK (received_amount > 0),
        CONSTRAINT payment_receipts_status_check CHECK (status IN ('ISSUED','VOID')),
        CONSTRAINT payment_receipts_void_state_check CHECK (
          (status = 'ISSUED' AND voided_at IS NULL AND voided_by_user_id IS NULL)
          OR (status = 'VOID' AND voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX payment_receipts_reference_unique
        ON payment_receipts (client_id, payment_reference)
        WHERE payment_reference IS NOT NULL;
      CREATE INDEX payment_receipts_invoice_idx
        ON payment_receipts (invoice_id, received_at DESC);
      CREATE INDEX payment_receipts_payment_status_idx
        ON payment_receipts (invoice_payment_status_id, status, received_at);
      CREATE INDEX payment_receipts_tenant_idx
        ON payment_receipts (tenant_company_id, received_at DESC);
      CREATE INDEX payment_receipts_building_idx
        ON payment_receipts (building_id, received_at DESC)
    `);

    await client.query(`
      CREATE TABLE payment_receipt_history (
        id                 UUID PRIMARY KEY,
        payment_receipt_id UUID NOT NULL REFERENCES payment_receipts (id),
        action             TEXT NOT NULL,
        status             TEXT NOT NULL,
        received_amount    NUMERIC NOT NULL,
        received_at        TIMESTAMPTZ NOT NULL,
        payment_reference  TEXT,
        payment_method     TEXT,
        notes              TEXT,
        changed_by_user_id UUID NOT NULL REFERENCES users (id),
        changed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT payment_receipt_history_action_check
          CHECK (action IN ('ISSUED','VOIDED'))
      )
    `);
    await client.query(`
      CREATE INDEX payment_receipt_history_receipt_idx
        ON payment_receipt_history (payment_receipt_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS payment_receipt_history');
    await client.query('DROP TABLE IF EXISTS payment_receipts');
  },
};
