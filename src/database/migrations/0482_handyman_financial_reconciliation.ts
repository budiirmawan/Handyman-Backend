import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Integration facts only: the existing quotation, payment, correction and
 * settlement engines remain the ONLY money writers. No tax status/rate,
 * inspection fee, BM percentage or integration enrollment is seeded. */
export const migration0482HandymanFinancialReconciliation: Migration = {
  id: '0482_handyman_financial_reconciliation',
  async up(c: PoolClient) {
    await c.query(`
      CREATE TABLE handyman_inspection_fee_offers (
        quotation_version_id uuid PRIMARY KEY REFERENCES handyman_quotation_versions(id),
        handyman_request_id uuid NOT NULL REFERENCES handyman_service_requests(id),
        treatment text NOT NULL CHECK(treatment IN ('PAID_CREDITED','PAID_SEPARATE')),
        no_proceed_treatment text NOT NULL CHECK(no_proceed_treatment IN ('RETAIN_AGREED_FEE','REFUND_AGREED_FEE')),
        credit_mode text NOT NULL CHECK(credit_mode='SEPARATE_SERVICE_DISCOUNT'),
        created_by_user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_inspection_fee_terms (
        id uuid PRIMARY KEY, handyman_request_id uuid NOT NULL UNIQUE REFERENCES handyman_service_requests(id),
        treatment text NOT NULL CHECK(treatment IN ('FREE','PAID_CREDITED','PAID_SEPARATE')),
        fee_execution_scope_id uuid UNIQUE REFERENCES handyman_execution_scopes(id),
        no_proceed_treatment text NOT NULL CHECK(no_proceed_treatment IN ('NOT_APPLICABLE','RETAIN_AGREED_FEE','REFUND_AGREED_FEE')),
        agreed_amount numeric(18,2) NOT NULL CHECK(agreed_amount >= 0), currency text NOT NULL,
        created_by_user_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((treatment='FREE' AND fee_execution_scope_id IS NULL AND agreed_amount=0 AND no_proceed_treatment='NOT_APPLICABLE')
          OR (treatment<>'FREE' AND fee_execution_scope_id IS NOT NULL AND agreed_amount>0 AND no_proceed_treatment<>'NOT_APPLICABLE'))
      );
      CREATE TABLE handyman_inspection_fee_credits (
        id uuid PRIMARY KEY, terms_id uuid NOT NULL UNIQUE REFERENCES handyman_inspection_fee_terms(id),
        job_execution_scope_id uuid NOT NULL REFERENCES handyman_execution_scopes(id),
        correction_id uuid NOT NULL UNIQUE REFERENCES handyman_ledger_corrections(id),
        created_by_user_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_financial_tax_profiles (
        id uuid PRIMARY KEY, quotation_version_id uuid UNIQUE REFERENCES handyman_quotation_versions(id),
        agreement_version_id uuid UNIQUE REFERENCES handyman_commercial_agreement_versions(id),
        facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
        created_by_user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK(num_nonnulls(quotation_version_id,agreement_version_id)=1)
      );
      CREATE TABLE handyman_payment_reconciliations (
        id uuid PRIMARY KEY, payment_id uuid NOT NULL UNIQUE REFERENCES handyman_customer_payments(id),
        client_id uuid NOT NULL REFERENCES clients(id), bank_reference text NOT NULL CHECK(length(btrim(bank_reference)) BETWEEN 1 AND 200),
        actual_received_at timestamptz NOT NULL,
        verified_by_user_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL,
        verified_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(client_id,bank_reference)
      );
      CREATE TABLE handyman_bm_fee_fiscal_bases (
        entitlement_id uuid PRIMARY KEY REFERENCES handyman_entitlement_facts(id),
        tenant_profile_id uuid NOT NULL REFERENCES handyman_financial_tax_profiles(id),
        bm_profile_id uuid NOT NULL REFERENCES handyman_financial_tax_profiles(id),
        basis_ex_vat numeric(18,2) NOT NULL CHECK(basis_ex_vat>=0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_fiscal_documents (
        id uuid PRIMARY KEY, execution_scope_id uuid NOT NULL REFERENCES handyman_execution_scopes(id),
        profile_id uuid NOT NULL REFERENCES handyman_financial_tax_profiles(id),
        side text NOT NULL CHECK(side IN ('TENANT','BM')),
        document_kind text NOT NULL CHECK(document_kind IN ('ADVANCE','INSTALLMENT','FINAL','ADJUSTMENT','BM_FEE')),
        payment_id uuid UNIQUE REFERENCES handyman_customer_payments(id),
        entitlement_id uuid REFERENCES handyman_entitlement_facts(id),
        previous_document_id uuid REFERENCES handyman_fiscal_documents(id),
        tax_point_at timestamptz NOT NULL, document_date date NOT NULL,
        external_reference text NOT NULL CHECK(length(btrim(external_reference)) BETWEEN 1 AND 200),
        issuer_reference text NOT NULL, payer_reference text NOT NULL,
        withholding_reference text, reconciliation_reference text,
        amounts jsonb NOT NULL CHECK(jsonb_typeof(amounts)='object'),
        recorded_by_user_id uuid NOT NULL REFERENCES users(id), idempotency_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(execution_scope_id,side,idempotency_key), UNIQUE(issuer_reference,external_reference),
        CHECK((side='TENANT' AND entitlement_id IS NULL AND document_kind<>'BM_FEE') OR
          (side='BM' AND entitlement_id IS NOT NULL AND payment_id IS NULL AND document_kind='BM_FEE'))
      );
      CREATE UNIQUE INDEX handyman_fiscal_withholding_reference_unique ON handyman_fiscal_documents(payer_reference,withholding_reference) WHERE withholding_reference IS NOT NULL;
      CREATE TABLE handyman_fiscal_withholding_credits (
        document_id uuid PRIMARY KEY REFERENCES handyman_fiscal_documents(id),
        correction_id uuid NOT NULL UNIQUE REFERENCES handyman_ledger_corrections(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE FUNCTION handyman_financial_fact_no_mutation() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'Handyman financial integration facts are append-only.'; END; $$ LANGUAGE plpgsql;
    `);
    for (const table of [
      'handyman_inspection_fee_offers',
      'handyman_inspection_fee_terms',
      'handyman_inspection_fee_credits',
      'handyman_financial_tax_profiles',
      'handyman_bm_fee_fiscal_bases',
      'handyman_payment_reconciliations',
      'handyman_fiscal_documents',
      'handyman_fiscal_withholding_credits',
    ]) {
      await c.query(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION handyman_financial_fact_no_mutation()`);
    }
    await c.query(`
      CREATE FUNCTION handyman_financial_draft_guard() RETURNS trigger AS $$ DECLARE state text; BEGIN
        IF NEW.quotation_version_id IS NOT NULL THEN
          SELECT status INTO state FROM handyman_quotation_versions WHERE id=NEW.quotation_version_id FOR SHARE;
        ELSIF TG_TABLE_NAME='handyman_financial_tax_profiles' THEN
          SELECT status INTO state FROM handyman_commercial_agreement_versions WHERE id=NEW.agreement_version_id FOR SHARE;
        END IF;
        IF state IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Financial terms require the exact DRAFT version.'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_tax_profile_draft_guard BEFORE INSERT ON handyman_financial_tax_profiles
        FOR EACH ROW EXECUTE FUNCTION handyman_financial_draft_guard();
      CREATE TRIGGER handyman_inspection_offer_draft_guard BEFORE INSERT ON handyman_inspection_fee_offers
        FOR EACH ROW EXECUTE FUNCTION handyman_financial_draft_guard();
      CREATE FUNCTION handyman_credited_inspection_payment_guard() RETURNS trigger AS $$ BEGIN
        IF NEW.source_payment_id IS NOT NULL AND NEW.correction_kind IN ('REFUND','REVERSAL') AND EXISTS (
          SELECT 1 FROM handyman_customer_payments p
          JOIN handyman_customer_transactions t ON t.id=p.transaction_id
          JOIN handyman_inspection_fee_terms ft ON ft.fee_execution_scope_id=t.execution_scope_id
          JOIN handyman_inspection_fee_credits cr ON cr.terms_id=ft.id
          WHERE p.id=NEW.source_payment_id
        ) THEN RAISE EXCEPTION 'Credited inspection payment requires explicit credit compensation before refund/reversal.'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_credited_inspection_payment_guard BEFORE INSERT ON handyman_ledger_corrections
        FOR EACH ROW EXECUTE FUNCTION handyman_credited_inspection_payment_guard();
    `);
  },
  async down(c: PoolClient) {
    await c.query(`DROP TRIGGER IF EXISTS handyman_credited_inspection_payment_guard ON handyman_ledger_corrections;
      DROP FUNCTION IF EXISTS handyman_credited_inspection_payment_guard();
      DROP TABLE handyman_fiscal_withholding_credits, handyman_fiscal_documents, handyman_bm_fee_fiscal_bases, handyman_payment_reconciliations,
        handyman_financial_tax_profiles, handyman_inspection_fee_credits, handyman_inspection_fee_terms, handyman_inspection_fee_offers;
      DROP FUNCTION handyman_financial_draft_guard();
      DROP FUNCTION handyman_financial_fact_no_mutation();`);
  },
};
