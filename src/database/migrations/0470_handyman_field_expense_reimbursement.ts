import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-EXPENSE-HELPER-01 PART 01 — Foto Nota dan Reimbursement Petugas
 *
 * Extends the authoritative Handyman material purchasing & field expense
 * lifecycle (`0436_create_handyman_material_purchasing`) without duplicating
 * purchasing, evidence, or payment authorities:
 *
 *   1. Adds optional canonical `work_order_id` (`REFERENCES work_orders(id)`)
 *      and `receipt_sha256_checksum` to `handyman_material_purchase_records`.
 *   2. Enforces that ONLY worker personal out-of-pocket expenses
 *      (`funding_source = 'REIMBURSEMENT'`) may generate a reimbursement claim;
 *      Handyman cash advances (`CASH_ADVANCE`) and company funds
 *      (`PETTY_CASH`, `COMPANY_DIRECT`, `WAREHOUSE_STOCK`) must keep
 *      `reimbursement_status = 'NOT_APPLICABLE'` and `reimbursement_payable_amount = 0`.
 *   3. Adds Finance reimbursement approval/rejection and disbursement columns
 *      and expands `reimbursement_status` with `FINANCE_APPROVED`, `DISBURSED`,
 *      and `REJECTED`.
 *   4. Prevents disbursement without prior Operations verification
 *      (`status = 'RECONCILIATION'`) and Finance approval, double payment,
 *      duplicate receipt references/digests/supplier-invoice pairs, and
 *      cross-Work Order receipt reuse at the database constraint/index layer.
 *   5. Expands append-only `handyman_material_purchase_events` to audit Finance
 *      reimbursement approval, rejection, and disbursement transitions.
 */
export const migration0470HandymanFieldExpenseReimbursement: Migration = {
  id: '0470_handyman_field_expense_reimbursement',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_material_purchase_records
        ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES work_orders (id),
        ADD COLUMN IF NOT EXISTS receipt_sha256_checksum VARCHAR(64),
        ADD COLUMN IF NOT EXISTS reimbursement_finance_approval_reference TEXT,
        ADD COLUMN IF NOT EXISTS reimbursement_finance_approved_by_user_id UUID REFERENCES users (id),
        ADD COLUMN IF NOT EXISTS reimbursement_finance_approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reimbursement_disbursement_reference TEXT,
        ADD COLUMN IF NOT EXISTS reimbursement_disbursement_method TEXT
          CHECK (
            reimbursement_disbursement_method IS NULL
            OR reimbursement_disbursement_method IN (
              'BANK_TRANSFER',
              'PAYROLL_SETTLEMENT',
              'PETTY_CASH_PAYOUT'
            )
          ),
        ADD COLUMN IF NOT EXISTS reimbursement_disbursed_amount NUMERIC(18, 2) NOT NULL DEFAULT 0
          CHECK (reimbursement_disbursed_amount >= 0),
        ADD COLUMN IF NOT EXISTS reimbursement_disbursed_by_user_id UUID REFERENCES users (id),
        ADD COLUMN IF NOT EXISTS reimbursement_disbursed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reimbursement_rejected_by_user_id UUID REFERENCES users (id),
        ADD COLUMN IF NOT EXISTS reimbursement_rejected_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reimbursement_rejection_reason TEXT
    `);

    // Ensure any pre-existing non-personal-funds rows satisfy the personal-funds-only rule.
    await client.query(`
      UPDATE handyman_material_purchase_records
         SET reimbursement_status = 'NOT_APPLICABLE',
             reimbursement_payable_amount = 0,
             reimbursement_payee_user_id = NULL
       WHERE funding_source <> 'REIMBURSEMENT'
         AND (
           reimbursement_status <> 'NOT_APPLICABLE'
           OR reimbursement_payable_amount <> 0
           OR reimbursement_payee_user_id IS NOT NULL
         )
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_records
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_records_reimbursement_status_check,
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_reimbursement_status_chk,
        DROP CONSTRAINT IF EXISTS handyman_material_reimbursement_personal_funds_only_chk,
        DROP CONSTRAINT IF EXISTS handyman_material_reimbursement_approval_gate_chk
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_records
        ADD CONSTRAINT handyman_material_purchase_reimbursement_status_chk
          CHECK (reimbursement_status IN (
            'NOT_APPLICABLE',
            'PENDING_RECONCILIATION',
            'RECONCILED_PAYABLE',
            'FINANCE_APPROVED',
            'DISBURSED',
            'REJECTED'
          )),
        ADD CONSTRAINT handyman_material_reimbursement_personal_funds_only_chk
          CHECK (
            funding_source = 'REIMBURSEMENT'
            OR (
              reimbursement_status = 'NOT_APPLICABLE'
              AND reimbursement_payable_amount = 0
              AND reimbursement_payee_user_id IS NULL
              AND reimbursement_finance_approved_by_user_id IS NULL
              AND reimbursement_disbursed_by_user_id IS NULL
              AND reimbursement_disbursed_amount = 0
            )
          ),
        ADD CONSTRAINT handyman_material_reimbursement_approval_gate_chk
          CHECK (
            (
              reimbursement_status <> 'FINANCE_APPROVED'
              OR (
                funding_source = 'REIMBURSEMENT'
                AND status = 'RECONCILIATION'
                AND reimbursement_payable_amount > 0
                AND reimbursement_finance_approval_reference IS NOT NULL
                AND reimbursement_finance_approved_by_user_id IS NOT NULL
                AND reimbursement_finance_approved_at IS NOT NULL
              )
            )
            AND (
              reimbursement_status <> 'DISBURSED'
              OR (
                funding_source = 'REIMBURSEMENT'
                AND status = 'RECONCILIATION'
                AND reimbursement_payable_amount > 0
                AND reimbursement_finance_approval_reference IS NOT NULL
                AND reimbursement_finance_approved_by_user_id IS NOT NULL
                AND reimbursement_finance_approved_at IS NOT NULL
                AND reimbursement_disbursement_reference IS NOT NULL
                AND reimbursement_disbursed_by_user_id IS NOT NULL
                AND reimbursement_disbursed_at IS NOT NULL
                AND reimbursement_disbursed_amount = reimbursement_payable_amount
              )
            )
          )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS handyman_material_purchase_records_work_order_idx
        ON handyman_material_purchase_records (work_order_id, created_at ASC, id ASC)
        WHERE work_order_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS handyman_material_purchase_records_reimb_queue_idx
        ON handyman_material_purchase_records (building_id, reimbursement_status, created_at DESC, id DESC)
        WHERE funding_source = 'REIMBURSEMENT';

      CREATE UNIQUE INDEX IF NOT EXISTS handyman_material_purchase_receipt_ref_uniq
        ON handyman_material_purchase_records (receipt_evidence_reference)
        WHERE receipt_evidence_reference IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS handyman_material_purchase_receipt_sha256_uniq
        ON handyman_material_purchase_records (client_id, receipt_sha256_checksum)
        WHERE receipt_sha256_checksum IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS handyman_material_purchase_supplier_invoice_uniq
        ON handyman_material_purchase_records (
          client_id,
          lower(btrim(supplier_name)),
          lower(btrim(purchase_reference))
        )
        WHERE status NOT IN ('REQUEST', 'ISSUED')
          AND supplier_name IS NOT NULL
          AND purchase_reference IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS handyman_material_reimbursement_disburse_ref_uniq
        ON handyman_material_purchase_records (
          client_id,
          lower(btrim(reimbursement_disbursement_reference))
        )
        WHERE reimbursement_disbursement_reference IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_events
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_events_event_type_check,
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_events_event_type_chk,
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_events_actor_role_check,
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_events_actor_role_chk
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_events
        ADD CONSTRAINT handyman_material_purchase_events_event_type_chk
          CHECK (event_type IN (
            'REQUEST',
            'APPROVAL',
            'ISSUED',
            'PURCHASED',
            'USAGE',
            'RETURN',
            'RECONCILIATION',
            'REIMBURSEMENT_APPROVED',
            'REIMBURSEMENT_REJECTED',
            'REIMBURSEMENT_DISBURSED'
          )),
        ADD CONSTRAINT handyman_material_purchase_events_actor_role_chk
          CHECK (actor_role IN (
            'PIC_PEKERJAAN',
            'OPERATIONS_MANAGER',
            'FINANCE_MANAGER'
          ))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS handyman_material_reimbursement_disburse_ref_uniq;
      DROP INDEX IF EXISTS handyman_material_purchase_supplier_invoice_uniq;
      DROP INDEX IF EXISTS handyman_material_purchase_receipt_sha256_uniq;
      DROP INDEX IF EXISTS handyman_material_purchase_receipt_ref_uniq;
      DROP INDEX IF EXISTS handyman_material_purchase_records_reimb_queue_idx;
      DROP INDEX IF EXISTS handyman_material_purchase_records_work_order_idx;
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_records
        DROP CONSTRAINT IF EXISTS handyman_material_reimbursement_approval_gate_chk,
        DROP CONSTRAINT IF EXISTS handyman_material_reimbursement_personal_funds_only_chk,
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_reimbursement_status_chk
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_records
        ADD CONSTRAINT handyman_material_purchase_records_reimbursement_status_check
          CHECK (reimbursement_status IN (
            'NOT_APPLICABLE',
            'PENDING_RECONCILIATION',
            'RECONCILED_PAYABLE'
          ))
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_records
        DROP COLUMN IF EXISTS reimbursement_rejection_reason,
        DROP COLUMN IF EXISTS reimbursement_rejected_at,
        DROP COLUMN IF EXISTS reimbursement_rejected_by_user_id,
        DROP COLUMN IF EXISTS reimbursement_disbursed_at,
        DROP COLUMN IF EXISTS reimbursement_disbursed_by_user_id,
        DROP COLUMN IF EXISTS reimbursement_disbursed_amount,
        DROP COLUMN IF EXISTS reimbursement_disbursement_method,
        DROP COLUMN IF EXISTS reimbursement_disbursement_reference,
        DROP COLUMN IF EXISTS reimbursement_finance_approved_at,
        DROP COLUMN IF EXISTS reimbursement_finance_approved_by_user_id,
        DROP COLUMN IF EXISTS reimbursement_finance_approval_reference,
        DROP COLUMN IF EXISTS receipt_sha256_checksum,
        DROP COLUMN IF EXISTS work_order_id
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_events
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_events_event_type_chk,
        DROP CONSTRAINT IF EXISTS handyman_material_purchase_events_actor_role_chk
    `);

    await client.query(`
      ALTER TABLE handyman_material_purchase_events
        ADD CONSTRAINT handyman_material_purchase_events_event_type_check
          CHECK (event_type IN (
            'REQUEST',
            'APPROVAL',
            'ISSUED',
            'PURCHASED',
            'USAGE',
            'RETURN',
            'RECONCILIATION'
          )),
        ADD CONSTRAINT handyman_material_purchase_events_actor_role_check
          CHECK (actor_role IN ('PIC_PEKERJAAN', 'OPERATIONS_MANAGER'))
    `);
  },
};
