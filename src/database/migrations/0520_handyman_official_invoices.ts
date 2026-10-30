import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Inclusive Handyman invoices are NOT tenant_invoices: the latter's subtotal =
 * total contract cannot describe the reviewed DPP/PPN projection.  This is a
 * single immutable issuance artifact, not another payment or tax engine.
 */
export const migration0520HandymanOfficialInvoices: Migration = {
  id: '0520_handyman_official_invoices',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_official_invoice_number_seq;
      CREATE TABLE handyman_official_invoices (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        execution_scope_id UUID NOT NULL UNIQUE REFERENCES handyman_execution_scopes(id),
        transaction_id UUID NOT NULL UNIQUE REFERENCES handyman_customer_transactions(id),
        classification_id UUID NOT NULL REFERENCES handyman_customer_tax_classifications(id),
        issuer_profile_id UUID NOT NULL REFERENCES handyman_document_issuer_profiles(id),
        bank_version_id UUID NOT NULL REFERENCES handyman_document_issuer_bank_accounts(id),
        settings_id UUID NOT NULL REFERENCES handyman_document_issuer_document_settings(id),
        document_number TEXT NOT NULL UNIQUE,
        issued_by_user_id UUID NOT NULL REFERENCES users(id),
        issued_at TIMESTAMPTZ NOT NULL,
        currency VARCHAR(3) NOT NULL CHECK (currency='IDR'),
        total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount>=0),
        source_snapshot JSONB NOT NULL,
        source_canonical TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename TEXT NOT NULL CHECK (pdf_filename ~ '^invoice-[a-z0-9-]+[.]pdf$'),
        pdf_bytes BYTEA NOT NULL,
        pdf_size INTEGER NOT NULL CHECK (pdf_size BETWEEN 1 AND 10485760),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        CHECK (source_canonical::jsonb=source_snapshot),
        CHECK (encode(sha256(convert_to(source_canonical,'UTF8')),'hex')=source_sha256),
        CHECK (octet_length(pdf_bytes)=pdf_size AND substring(pdf_bytes from 1 for 5)=convert_to('%PDF-','UTF8')),
        CHECK (encode(sha256(pdf_bytes),'hex')=pdf_sha256)
      );
      CREATE INDEX hm_official_invoice_request_idx ON handyman_official_invoices(client_id,building_id,request_id);

      -- One shared uniqueness arbitration covers both the pre-existing generic
      -- invoice binding and the new official document, even under concurrent
      -- INSERTs. Existing bindings are claimed, not migrated or reinterpreted.
      CREATE TABLE handyman_invoice_scope_claims (
        execution_scope_id UUID PRIMARY KEY REFERENCES handyman_execution_scopes(id),
        generic_invoice_id UUID UNIQUE REFERENCES tenant_invoices(id) DEFERRABLE INITIALLY DEFERRED,
        official_invoice_id UUID UNIQUE REFERENCES handyman_official_invoices(id) DEFERRABLE INITIALLY DEFERRED,
        CHECK ((generic_invoice_id IS NOT NULL)::int + (official_invoice_id IS NOT NULL)::int = 1)
      );
      INSERT INTO handyman_invoice_scope_claims(execution_scope_id,generic_invoice_id)
        SELECT handyman_execution_scope_id,id FROM tenant_invoices WHERE handyman_execution_scope_id IS NOT NULL;
      CREATE FUNCTION hm_invoice_claim_generic() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.handyman_execution_scope_id IS NULL OR
          (TG_OP='UPDATE' AND OLD.handyman_execution_scope_id IS NOT DISTINCT FROM NEW.handyman_execution_scope_id) THEN RETURN NEW; END IF;
        INSERT INTO handyman_invoice_scope_claims(execution_scope_id,generic_invoice_id)
          VALUES(NEW.handyman_execution_scope_id,NEW.id) ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM handyman_invoice_scope_claims WHERE execution_scope_id=NEW.handyman_execution_scope_id AND generic_invoice_id=NEW.id) THEN
          RAISE EXCEPTION 'This Handyman scope already has an invoice binding.' USING ERRCODE='23505';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_invoice_claim_generic BEFORE INSERT OR UPDATE OF handyman_execution_scope_id ON tenant_invoices
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_claim_generic();
      CREATE FUNCTION hm_invoice_claim_official() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO handyman_invoice_scope_claims(execution_scope_id,official_invoice_id)
          VALUES(NEW.execution_scope_id,NEW.id) ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM handyman_invoice_scope_claims WHERE execution_scope_id=NEW.execution_scope_id AND official_invoice_id=NEW.id) THEN
          RAISE EXCEPTION 'This Handyman scope already has an invoice binding.' USING ERRCODE='23505';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM handyman_execution_scopes s
          JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id
            AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
          JOIN handyman_customer_transactions t ON t.execution_scope_id=s.id AND t.client_id=s.client_id
          WHERE s.id=NEW.execution_scope_id AND s.client_id=NEW.client_id AND s.building_id=NEW.building_id
            AND s.handyman_request_id=NEW.request_id AND s.tenant_company_id=NEW.tenant_company_id
            AND t.id=NEW.transaction_id AND t.currency=NEW.currency)
          OR NEW.source_snapshot#>>'{issuance,id}' IS DISTINCT FROM NEW.id::text
          OR NEW.source_snapshot#>>'{issuance,number}' IS DISTINCT FROM NEW.document_number
          OR NEW.source_snapshot#>>'{calculation,clientId}' IS DISTINCT FROM NEW.client_id::text
          OR NEW.source_snapshot#>>'{calculation,requestId}' IS DISTINCT FROM NEW.request_id::text
          OR NEW.source_snapshot#>>'{calculation,commercialSource,executionScopeId}' IS DISTINCT FROM NEW.execution_scope_id::text
          OR NEW.source_snapshot#>>'{calculation,commercialSource,transactionId}' IS DISTINCT FROM NEW.transaction_id::text
          OR NEW.source_snapshot#>>'{calculation,classification,pin,classificationId}' IS DISTINCT FROM NEW.classification_id::text
          OR (NEW.source_snapshot#>>'{calculation,totalIncludingPpn}')::numeric IS DISTINCT FROM NEW.total_amount
        THEN RAISE EXCEPTION 'Official invoice source and scope must agree.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_invoice_claim_official BEFORE INSERT ON handyman_official_invoices
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_claim_official();
      CREATE FUNCTION hm_official_invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM handyman_official_invoices) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Issued Handyman invoices are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_official_invoice_no_change BEFORE UPDATE OR DELETE ON handyman_official_invoices
        FOR EACH ROW EXECUTE FUNCTION hm_official_invoice_immutable();
      CREATE TRIGGER hm_official_invoice_no_truncate BEFORE TRUNCATE ON handyman_official_invoices
        FOR EACH STATEMENT EXECUTE FUNCTION hm_official_invoice_immutable();
      CREATE FUNCTION hm_invoice_claim_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM handyman_invoice_scope_claims) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Handyman invoice scope claims are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_invoice_claim_no_change BEFORE UPDATE OR DELETE ON handyman_invoice_scope_claims
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_claim_immutable();
      CREATE TRIGGER hm_invoice_claim_no_truncate BEFORE TRUNCATE ON handyman_invoice_scope_claims
        FOR EACH STATEMENT EXECUTE FUNCTION hm_invoice_claim_immutable();

      -- A versioned per-scope fence makes source changes visible even when a
      -- REPEATABLE READ issuer waited for a concurrent writer after taking its
      -- snapshot. Only billing source changes touch it; payment facts do not.
      CREATE TABLE handyman_invoice_source_fences (
        execution_scope_id UUID PRIMARY KEY REFERENCES handyman_execution_scopes(id) ON DELETE CASCADE,
        revision BIGINT NOT NULL DEFAULT 0
      );
      INSERT INTO handyman_invoice_source_fences(execution_scope_id) SELECT id FROM handyman_execution_scopes;
      CREATE FUNCTION hm_invoice_fence_new_scope() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO handyman_invoice_source_fences(execution_scope_id) VALUES(NEW.id); RETURN NEW; END; $$;
      CREATE TRIGGER hm_invoice_fence_new_scope AFTER INSERT ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_fence_new_scope();
      CREATE FUNCTION hm_invoice_variation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE handyman_invoice_source_fences SET revision=revision+1 WHERE execution_scope_id=NEW.execution_scope_id;
        IF TG_OP='UPDATE' AND NEW.status='FINAL_CHARGE_ELIGIBILITY' AND OLD.status IS DISTINCT FROM NEW.status
          AND EXISTS(SELECT 1 FROM handyman_official_invoices WHERE execution_scope_id=NEW.execution_scope_id) THEN
          RAISE EXCEPTION 'Cannot admit a variation to final charge after official invoice issuance.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_invoice_variation_fence BEFORE INSERT OR UPDATE ON handyman_scope_variations
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_variation_fence();
      CREATE FUNCTION hm_invoice_ledger_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE sid UUID;
      BEGIN
        IF TG_TABLE_NAME='handyman_ledger_corrections' THEN
          IF NEW.correction_kind <> 'ADJUSTMENT' THEN RETURN NEW; END IF;
        END IF;
        SELECT execution_scope_id INTO sid FROM handyman_customer_transactions WHERE id=NEW.transaction_id;
        UPDATE handyman_invoice_source_fences SET revision=revision+1 WHERE execution_scope_id=sid;
        IF TG_TABLE_NAME='handyman_charge_lines' AND EXISTS(SELECT 1 FROM handyman_official_invoices WHERE execution_scope_id=sid) THEN
          RAISE EXCEPTION 'A new charge cannot be added to an issued official invoice.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_invoice_charge_fence BEFORE INSERT ON handyman_charge_lines
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_ledger_source_fence();
      CREATE TRIGGER hm_invoice_adjustment_fence BEFORE INSERT ON handyman_ledger_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_ledger_source_fence();
      CREATE FUNCTION hm_invoice_reduce_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE handyman_invoice_source_fences SET revision=revision+1 WHERE execution_scope_id=NEW.execution_scope_id;
        IF EXISTS(SELECT 1 FROM handyman_official_invoices WHERE execution_scope_id=NEW.execution_scope_id) THEN
          RAISE EXCEPTION 'An issued invoice requires an independent governed correction for later REDUCE.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_invoice_reduce_guard BEFORE INSERT ON handyman_reduce_financial_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_invoice_reduce_guard();
      CREATE FUNCTION hm_official_invoice_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM handyman_official_invoices i WHERE i.transaction_id=NEW.transaction_id
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.source_snapshot#>'{calculation,commercialSource,lines}') l
            WHERE l->>'chargeLineId'=NEW.charge_line_id::text)) THEN
          RAISE EXCEPTION 'Allocations for an official invoice must target its linked source charge.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_official_invoice_allocation_guard BEFORE INSERT ON handyman_payment_allocations
        FOR EACH ROW EXECUTE FUNCTION hm_official_invoice_allocation_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_official_invoices IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM handyman_official_invoices) THEN
        RAISE EXCEPTION 'Cannot remove issued Handyman invoices.'; END IF; END $$;
      DROP TRIGGER hm_official_invoice_allocation_guard ON handyman_payment_allocations;
      DROP FUNCTION hm_official_invoice_allocation_guard();
      DROP TRIGGER hm_invoice_reduce_guard ON handyman_reduce_financial_corrections;
      DROP FUNCTION hm_invoice_reduce_guard();
      DROP TRIGGER hm_invoice_adjustment_fence ON handyman_ledger_corrections;
      DROP TRIGGER hm_invoice_charge_fence ON handyman_charge_lines;
      DROP FUNCTION hm_invoice_ledger_source_fence();
      DROP TRIGGER hm_invoice_variation_fence ON handyman_scope_variations;
      DROP FUNCTION hm_invoice_variation_fence();
      DROP TRIGGER hm_invoice_fence_new_scope ON handyman_execution_scopes;
      DROP FUNCTION hm_invoice_fence_new_scope();
      DROP TABLE handyman_invoice_source_fences;
      DROP TRIGGER hm_invoice_claim_generic ON tenant_invoices;
      DROP FUNCTION hm_invoice_claim_generic();
      DROP TRIGGER hm_invoice_claim_official ON handyman_official_invoices;
      DROP FUNCTION hm_invoice_claim_official();
      DROP TABLE handyman_invoice_scope_claims;
      DROP FUNCTION hm_invoice_claim_immutable();
      DROP TABLE handyman_official_invoices;
      DROP FUNCTION hm_official_invoice_immutable();
      DROP SEQUENCE handyman_official_invoice_number_seq;
    `);
  },
};
