import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Bounded Handyman payment proof on the shared evidence engine.
 *
 * A proof row is an evidence_submissions child of exactly one existing
 * PENDING payment claim. The payment's immutable transaction -> execution
 * scope -> unique finalized Handyman invoice chain supplies tenant, building,
 * space, currency, request and invoice context. This migration adds no
 * parallel evidence or payment model and does not confirm funds, allocate
 * money, or derive invoice status.
 */
export const migration0433HandymanCustomerPaymentProof: Migration = {
  id: '0433_handyman_customer_payment_proof',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution CHECK (execution_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER', 'VENDOR_WORK',
          'UTILITY_METER_READING', 'PERMIT', 'FINDING', 'FINDING_REWORK',
          'FINDING_VERIFICATION', 'HANDYMAN_REQUEST',
          'HANDYMAN_CUSTOMER_PAYMENT')),
        ADD CONSTRAINT evidence_handyman_payment_proof_type_check CHECK (
          execution_type <> 'HANDYMAN_CUSTOMER_PAYMENT'
          OR evidence_type IN ('PHOTO', 'DOCUMENT')),
        ADD CONSTRAINT evidence_handyman_payment_proof_upload_check CHECK (
          execution_type <> 'HANDYMAN_CUSTOMER_PAYMENT'
          OR (file_reference = 'evidence/' || id::text
              AND file_size > 0 AND content_sha256 IS NOT NULL
              AND ((evidence_type = 'PHOTO'
                    AND mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
                OR (evidence_type = 'DOCUMENT'
                    AND mime_type IN ('application/pdf', 'image/jpeg', 'image/png'))))
        )
    `);
    await client.query(`
      CREATE UNIQUE INDEX evidence_handyman_payment_one_proof_idx
        ON evidence_submissions (execution_id)
        WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
    `);
    await client.query(`
      CREATE FUNCTION handyman_customer_payment_proof_guard()
      RETURNS trigger AS $$
      DECLARE
        payment_client UUID;
        payment_status TEXT;
        payment_currency VARCHAR(3);
        scope_id UUID;
        scope_client UUID;
        scope_request UUID;
        scope_tenant UUID;
        scope_building UUID;
        scope_space UUID;
        bound_invoice_id UUID;
        invoice_client UUID;
        invoice_tenant UUID;
        invoice_building UUID;
        invoice_space UUID;
        invoice_currency VARCHAR(3);
        invoice_status TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT' THEN
            RAISE EXCEPTION 'Handyman customer payment evidence is retained as a bound evidence fact.'
              USING ERRCODE = '23514';
          END IF;
          RETURN OLD;
        END IF;

        IF TG_OP = 'UPDATE' THEN
          IF OLD.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
             AND (NEW.id IS DISTINCT FROM OLD.id
               OR NEW.client_id IS DISTINCT FROM OLD.client_id
               OR NEW.execution_type IS DISTINCT FROM OLD.execution_type
               OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
               OR NEW.evidence_type IS DISTINCT FROM OLD.evidence_type
               OR NEW.file_reference IS DISTINCT FROM OLD.file_reference
               OR NEW.original_file_name IS DISTINCT FROM OLD.original_file_name
               OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
               OR NEW.file_size IS DISTINCT FROM OLD.file_size
               OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
               OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
               OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
               OR NEW.content_hashed_at IS DISTINCT FROM OLD.content_hashed_at
               OR NEW.hash_algorithm IS DISTINCT FROM OLD.hash_algorithm) THEN
            RAISE EXCEPTION 'Handyman payment proof identity and uploaded bytes are immutable.'
              USING ERRCODE = '23514';
          END IF;
          IF OLD.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
             AND OLD.status = 'REMOVED' AND NEW.status IS DISTINCT FROM 'REMOVED' THEN
            RAISE EXCEPTION 'Removed Handyman payment proof cannot be reactivated.'
              USING ERRCODE = '23514';
          END IF;
          IF OLD.execution_type <> 'HANDYMAN_CUSTOMER_PAYMENT'
             AND NEW.execution_type = 'HANDYMAN_CUSTOMER_PAYMENT' THEN
            RAISE EXCEPTION 'Existing evidence cannot be rebound as Handyman payment proof.'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.execution_type <> 'HANDYMAN_CUSTOMER_PAYMENT' THEN
          RETURN NEW;
        END IF;
        IF NEW.evidence_type NOT IN ('PHOTO', 'DOCUMENT')
           OR NEW.file_reference IS DISTINCT FROM 'evidence/' || NEW.id::text
           OR NEW.file_size <= 0 OR NEW.content_sha256 IS NULL
           OR NEW.mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
          RAISE EXCEPTION 'Handyman payment proof must be a successfully uploaded PHOTO or DOCUMENT.'
            USING ERRCODE = '23514';
        END IF;

        SELECT p.client_id, p.status, tx.currency,
               es.id, es.client_id, es.handyman_request_id, es.tenant_company_id,
               es.building_id, es.space_id,
               i.id, i.client_id, i.tenant_company_id, i.building_id, i.space_id,
               i.currency_code, i.status
          INTO payment_client, payment_status, payment_currency,
               scope_id, scope_client, scope_request, scope_tenant, scope_building,
               scope_space, bound_invoice_id, invoice_client, invoice_tenant, invoice_building,
               invoice_space, invoice_currency, invoice_status
          FROM handyman_customer_payments p
          JOIN handyman_customer_transactions tx ON tx.id = p.transaction_id
          JOIN handyman_execution_scopes es ON es.id = tx.execution_scope_id
          JOIN tenant_invoices i ON i.handyman_execution_scope_id = es.id
         WHERE p.id = NEW.execution_id;
        IF NOT FOUND OR payment_status IS DISTINCT FROM 'PENDING'
           OR NEW.client_id IS DISTINCT FROM payment_client
           OR payment_client IS DISTINCT FROM scope_client
           OR invoice_client IS DISTINCT FROM scope_client
           OR invoice_tenant IS DISTINCT FROM scope_tenant
           OR invoice_building IS DISTINCT FROM scope_building
           OR invoice_space IS DISTINCT FROM scope_space
           OR invoice_currency IS DISTINCT FROM payment_currency
           OR invoice_status IS DISTINCT FROM 'FINALIZED'
           OR scope_request IS NULL
           OR EXISTS (
             SELECT 1 FROM tenant_invoice_lines il
              WHERE il.invoice_id = bound_invoice_id
                AND il.source_type <> 'HANDYMAN_CHARGE'
           )
           OR NOT EXISTS (
             SELECT 1
               FROM tenant_invoice_lines il
               JOIN handyman_charge_lines cl ON cl.id = il.handyman_charge_line_id
               JOIN handyman_customer_transactions source_tx ON source_tx.id = cl.transaction_id
              WHERE il.invoice_id = bound_invoice_id
                AND il.source_type = 'HANDYMAN_CHARGE'
                AND source_tx.execution_scope_id = scope_id
           ) THEN
          RAISE EXCEPTION 'Handyman payment proof must bind to a pending claim and its finalized invoice context.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_customer_payment_proof_guard
        BEFORE INSERT OR UPDATE OR DELETE ON evidence_submissions
        FOR EACH ROW EXECUTE FUNCTION handyman_customer_payment_proof_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_payment_proof_guard ON evidence_submissions;
      DROP FUNCTION IF EXISTS handyman_customer_payment_proof_guard();
      DROP INDEX IF EXISTS evidence_handyman_payment_one_proof_idx;
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT IF EXISTS evidence_handyman_payment_proof_upload_check,
        DROP CONSTRAINT IF EXISTS evidence_handyman_payment_proof_type_check,
        DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution CHECK (execution_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER', 'VENDOR_WORK',
          'UTILITY_METER_READING', 'PERMIT', 'FINDING', 'FINDING_REWORK',
          'FINDING_VERIFICATION', 'HANDYMAN_REQUEST'));
    `);
  },
};
