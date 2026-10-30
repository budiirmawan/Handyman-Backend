import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * A REDUCE is provenance for ONE existing ledger ADJUSTMENT, not a second
 * ledger. The ledger stores positive magnitudes and ADJUSTMENT means a
 * decrease; the binding stores the exact approved signed delta. No historical
 * adjustment is guessed or backfilled. Zero-value reductions are witnessed
 * without fabricating a zero-valued ledger correction.
 */
export const migration0517HandymanReduceFinancialCorrections: Migration = {
  id: '0517_handyman_reduce_financial_corrections',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_reduce_financial_corrections (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        transaction_id UUID NOT NULL REFERENCES handyman_customer_transactions(id),
        variation_id UUID NOT NULL UNIQUE REFERENCES handyman_scope_variations(id),
        variation_version INTEGER NOT NULL CHECK (variation_version > 0),
        approved_variation_version INTEGER NOT NULL CHECK (approved_variation_version > 0),
        decision_event_id UUID NOT NULL UNIQUE REFERENCES handyman_scope_variation_events(id),
        authorization_event_id UUID NOT NULL UNIQUE REFERENCES handyman_scope_variation_events(id),
        original_quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        revised_quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        quotation_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        charge_line_id UUID NOT NULL REFERENCES handyman_charge_lines(id),
        correction_id UUID UNIQUE REFERENCES handyman_ledger_corrections(id),
        approved_quantity NUMERIC(14,3) NOT NULL CHECK (approved_quantity > 0),
        approved_unit_amount NUMERIC(18,2) NOT NULL CHECK (approved_unit_amount >= 0),
        currency VARCHAR(3) NOT NULL,
        signed_amount NUMERIC(18,2) NOT NULL CHECK (signed_amount <= 0),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128 AND idempotency_key=btrim(idempotency_key)),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (execution_scope_id, idempotency_key),
        CHECK ((signed_amount < 0 AND correction_id IS NOT NULL)
            OR (signed_amount = 0 AND correction_id IS NULL))
      );
      CREATE INDEX hm_reduce_financial_charge_idx ON handyman_reduce_financial_corrections(charge_line_id);

      CREATE FUNCTION hm_reduce_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'REDUCE financial bindings are append-only.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_reduce_financial_no_write BEFORE UPDATE OR DELETE ON handyman_reduce_financial_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_reduce_financial_immutable();
      CREATE TRIGGER hm_reduce_financial_no_truncate BEFORE TRUNCATE ON handyman_reduce_financial_corrections
        FOR EACH STATEMENT EXECUTE FUNCTION hm_reduce_financial_immutable();

      -- SQL backstop for *every* writer. The adjustment must be new in the
      -- same transaction, so an arbitrary historical correction can never be
      -- retrospectively claimed as this variation's financial authority.
      CREATE FUNCTION hm_reduce_financial_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE amount_after NUMERIC; total_after NUMERIC;
      BEGIN
        IF current_setting('transaction_isolation') <> 'read committed' THEN
          RAISE EXCEPTION 'REDUCE corrections require READ COMMITTED.' USING ERRCODE='23514';
        END IF;
        PERFORM 1 FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        PERFORM 1 FROM handyman_customer_transactions WHERE id=NEW.transaction_id FOR UPDATE;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_scope_variations v
          JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id AND s.client_id=v.client_id
            AND s.building_id=v.building_id AND s.handyman_request_id=v.handyman_request_id
            AND s.tenant_company_id=v.tenant_company_id
          JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id
            AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
          JOIN handyman_customer_transactions t ON t.id=NEW.transaction_id AND t.execution_scope_id=s.id
            AND t.client_id=s.client_id AND t.quotation_version_id=s.approved_quotation_version_id
          JOIN handyman_quotation_versions original ON original.id=s.approved_quotation_version_id
            AND original.quotation_id=s.quotation_id
          JOIN handyman_quotation_versions revised ON revised.id=v.revised_quotation_version_id
            AND revised.quotation_id=s.quotation_id AND revised.version_number>original.version_number
            AND revised.status IN ('ISSUED','APPROVED')
          JOIN handyman_quotation_lines ql ON ql.id=v.target_quotation_line_id
            AND ql.quotation_version_id=original.id AND ql.line_type=v.line_type
            AND ql.uom_id=v.uom_id AND ql.currency=v.currency
          JOIN handyman_charge_lines l ON l.id=NEW.charge_line_id AND l.transaction_id=t.id
            AND l.client_id=s.client_id AND l.quotation_line_id=ql.id
            AND l.line_kind=ql.line_type AND l.currency=ql.currency AND l.amount=ql.line_total
          JOIN handyman_scope_variation_events d ON d.id=NEW.decision_event_id AND d.variation_id=v.id
            AND d.execution_scope_id=s.id AND d.client_id=s.client_id AND d.event_type='TENANT_DECISION'
            AND d.actor_role='TENANT' AND d.actor_user_id=v.tenant_decided_by_user_id
            AND d.metadata->>'decisionOutcome'='APPROVED'
          JOIN handyman_scope_variation_events a ON a.id=NEW.authorization_event_id AND a.variation_id=v.id
            AND a.execution_scope_id=s.id AND a.client_id=s.client_id AND a.event_type='AUTHORIZED_SCOPE'
            AND a.actor_role='OPERATIONS_MANAGER' AND a.from_status='TENANT_DECISION' AND a.to_status='AUTHORIZED_SCOPE'
          WHERE v.id=NEW.variation_id AND v.variation_type='REDUCE'
            AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
            AND v.tenant_decision_outcome='APPROVED' AND v.tenant_decided_at IS NOT NULL
            AND NOT v.invoiced AND v.version=NEW.variation_version
            AND NEW.approved_variation_version < NEW.variation_version
            AND NEW.client_id=s.client_id AND NEW.building_id=s.building_id AND NEW.execution_scope_id=s.id
            AND NEW.original_quotation_version_id=original.id AND NEW.revised_quotation_version_id=revised.id
            AND NEW.quotation_line_id=ql.id AND NEW.approved_quantity=v.quantity
            AND NEW.approved_unit_amount=v.quoted_unit_amount AND NEW.currency=t.currency
            AND NEW.currency=v.currency AND NEW.signed_amount=v.quoted_total_delta
            AND NEW.signed_amount<=0 AND round(v.quantity*v.quoted_unit_amount,2)=-NEW.signed_amount
            -- Document-backed decisions must still identify the exact
            -- immutable offered bytes. Legacy pinned decisions are not backfilled.
            AND (NOT EXISTS (SELECT 1 FROM handyman_scope_variation_events e
                  WHERE e.variation_id=v.id AND e.event_type='REVISED_QUOTATION'
                    AND e.actor_role='OPERATIONS_MANAGER' AND e.metadata ? 'offerDocument')
              OR EXISTS (SELECT 1 FROM handyman_scope_variation_events e
                JOIN handyman_variation_offer_documents offer
                  ON offer.id::text=e.metadata#>>'{offerDocument,id}' AND offer.variation_id=v.id
                WHERE e.variation_id=v.id AND e.event_type='REVISED_QUOTATION' AND e.actor_role='OPERATIONS_MANAGER'
                  AND offer.execution_scope_id=s.id AND offer.revised_quotation_version_id=revised.id
                  AND offer.variation_version=NEW.approved_variation_version
                  AND e.metadata#>>'{offerDocument,version}'=offer.variation_version::text
                  AND e.metadata#>>'{offerDocument,pdfSha256}'=offer.pdf_sha256
                  AND e.metadata#>>'{offerDocument,sourceSha256}'=offer.source_sha256
                  AND d.metadata#>>'{consentSnapshot,offerDocumentId}'=offer.id::text
                  AND d.metadata#>>'{consentSnapshot,offerDocumentVersion}'=offer.variation_version::text
                  AND d.metadata#>>'{consentSnapshot,offerPdfSha256}'=offer.pdf_sha256
                  AND offer.pdf_sha256=encode(sha256(offer.pdf_bytes),'hex')
                  AND offer.source_sha256=encode(sha256(convert_to(offer.source_canonical,'UTF8')),'hex')
                  AND offer.source_canonical::jsonb=offer.source_snapshot))
            AND (d.metadata#>>'{consentSnapshot,version}')::integer=NEW.approved_variation_version
            AND d.metadata#>>'{consentSnapshot,revisedQuotationVersionId}'=revised.id::text
            AND d.metadata#>>'{consentSnapshot,variationType}'='REDUCE'
            AND d.metadata#>>'{consentSnapshot,lineType}'=v.line_type
            AND d.metadata#>>'{consentSnapshot,targetQuotationLineId}'=ql.id::text
            AND d.metadata#>>'{consentSnapshot,title}'=v.title
            AND d.metadata#>>'{consentSnapshot,description}'=v.description
            AND d.metadata#>>'{consentSnapshot,technicalFinding}'=v.technical_finding
            AND (d.metadata#>>'{consentSnapshot,quantity}')::numeric=v.quantity
            AND d.metadata#>>'{consentSnapshot,uomId}'=v.uom_id::text
            AND (d.metadata#>>'{consentSnapshot,quotedUnitAmount}')::numeric=v.quoted_unit_amount
            AND (d.metadata#>>'{consentSnapshot,quotedTotalDelta}')::numeric=v.quoted_total_delta
            AND d.metadata#>>'{consentSnapshot,currency}'=v.currency
            AND a.metadata->>'variationType'='REDUCE'
            AND a.metadata->>'targetQuotationLineId'=ql.id::text
            AND (a.metadata->>'quantity')::numeric=v.quantity
            AND (SELECT count(*) FROM handyman_scope_variation_events e WHERE e.variation_id=v.id AND e.event_type='TENANT_DECISION')=1
            AND (SELECT count(*) FROM handyman_scope_variation_events e WHERE e.variation_id=v.id AND e.event_type='AUTHORIZED_SCOPE')=1
            AND (SELECT COALESCE(sum(x.quantity),0) FROM handyman_scope_variations x
                  WHERE x.execution_scope_id=s.id AND x.variation_type='REDUCE'
                    AND x.target_quotation_line_id=ql.id AND x.tenant_decision_outcome='APPROVED'
                    AND x.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY'))<=ql.quantity
            AND NOT EXISTS (SELECT 1 FROM tenant_invoices i WHERE i.handyman_execution_scope_id=s.id
                  AND i.client_id=s.client_id AND i.status='FINALIZED')
            AND (
              (NEW.signed_amount=0 AND NEW.correction_id IS NULL) OR
              (NEW.signed_amount<0 AND EXISTS (
                SELECT 1 FROM handyman_ledger_corrections c
                WHERE c.id=NEW.correction_id AND c.client_id=s.client_id AND c.transaction_id=t.id
                  AND c.correction_kind='ADJUSTMENT' AND c.source_kind='CHARGE_LINE'
                  AND c.source_charge_line_id=l.id AND c.currency=t.currency AND c.amount=-NEW.signed_amount
                  AND c.corrected_by_user_id=NEW.created_by_user_id
                  AND c.idempotency_key='variation-reduce:' || v.id::text
                  AND c.reason='Approved REDUCE variation ' || v.id::text
                  AND c.xmin=(pg_current_xact_id()::text)::xid
              ))
            )
        ) THEN
          RAISE EXCEPTION 'REDUCE requires the exact approved variation, original charge and same-transaction adjustment.' USING ERRCODE='23514';
        END IF;

        -- An unbound adjustment on this line, or on the whole transaction,
        -- may already be the REDUCE. Never guess from a reason or magnitude.
        -- Independently sourced inspection/fiscal credits remain distinct.
        IF EXISTS (
          SELECT 1 FROM handyman_ledger_corrections c WHERE c.transaction_id=NEW.transaction_id
            AND c.correction_kind='ADJUSTMENT' AND c.id IS DISTINCT FROM NEW.correction_id
            AND (c.source_kind='TRANSACTION' OR c.source_charge_line_id=NEW.charge_line_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.correction_id=c.id)
            AND NOT EXISTS (SELECT 1 FROM handyman_inspection_fee_credits x
              WHERE x.correction_id=c.id AND x.job_execution_scope_id=NEW.execution_scope_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_fiscal_withholding_credits x
              JOIN handyman_fiscal_documents f ON f.id=x.document_id
              WHERE x.correction_id=c.id AND f.execution_scope_id=NEW.execution_scope_id)
        ) THEN
          RAISE EXCEPTION 'Unbound ledger adjustment may already represent this REDUCE; explicit financial review required.' USING ERRCODE='23514';
        END IF;
        SELECT l.amount - COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
            WHERE c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id=l.id),0)
          INTO amount_after FROM handyman_charge_lines l WHERE l.id=NEW.charge_line_id;
        SELECT COALESCE((SELECT sum(l.amount) FROM handyman_charge_lines l WHERE l.transaction_id=NEW.transaction_id),0)
             - COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
                 WHERE c.transaction_id=NEW.transaction_id AND c.correction_kind='ADJUSTMENT'),0)
          INTO total_after;
        IF amount_after < 0 OR total_after < 0 THEN
          RAISE EXCEPTION 'REDUCE would exceed the net charge or transaction balance.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_reduce_financial_insert_guard BEFORE INSERT ON handyman_reduce_financial_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_reduce_financial_insert_guard();

      -- Once this provenance is recorded, approval terms may not later be
      -- rewritten even for legacy decisions without an official offer PDF.
      CREATE FUNCTION hm_reduce_bound_variation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.variation_id=OLD.id) AND (
          NEW.variation_type IS DISTINCT FROM OLD.variation_type OR NEW.line_type IS DISTINCT FROM OLD.line_type OR
          NEW.target_quotation_line_id IS DISTINCT FROM OLD.target_quotation_line_id OR
          NEW.revised_quotation_version_id IS DISTINCT FROM OLD.revised_quotation_version_id OR
          NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description OR
          NEW.technical_finding IS DISTINCT FROM OLD.technical_finding OR NEW.quantity IS DISTINCT FROM OLD.quantity OR
          NEW.uom_id IS DISTINCT FROM OLD.uom_id OR NEW.quoted_unit_amount IS DISTINCT FROM OLD.quoted_unit_amount OR
          NEW.quoted_total_delta IS DISTINCT FROM OLD.quoted_total_delta OR NEW.currency IS DISTINCT FROM OLD.currency OR
          NEW.tenant_decision_outcome IS DISTINCT FROM OLD.tenant_decision_outcome OR
          NEW.tenant_decided_by_user_id IS DISTINCT FROM OLD.tenant_decided_by_user_id OR
          NEW.tenant_decided_at IS DISTINCT FROM OLD.tenant_decided_at OR
          NEW.status NOT IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY') OR NEW.version<OLD.version
        ) THEN RAISE EXCEPTION 'A financially bound REDUCE approval is immutable.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_reduce_bound_variation_guard BEFORE UPDATE ON handyman_scope_variations
        FOR EACH ROW EXECUTE FUNCTION hm_reduce_bound_variation_guard();

      -- A later, unexplained generic adjustment could deduct the same REDUCE
      -- again. Allow only this binding or separately linked financial sources;
      -- preserve existing facts, and check at commit so integrations that
      -- atomically append their source binding after the correction still work.
      CREATE FUNCTION hm_reduce_adjustment_binding_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.correction_kind='ADJUSTMENT' AND (
          NEW.idempotency_key LIKE 'variation-reduce:%' OR EXISTS (
            SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.transaction_id=NEW.transaction_id
              AND (NEW.source_kind='TRANSACTION' OR b.charge_line_id=NEW.source_charge_line_id)
          )
        ) AND NOT EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.correction_id=NEW.id)
          AND NOT EXISTS (SELECT 1 FROM handyman_inspection_fee_credits x
            JOIN handyman_customer_transactions t ON t.id=NEW.transaction_id
            WHERE x.correction_id=NEW.id AND x.job_execution_scope_id=t.execution_scope_id)
          AND NOT EXISTS (SELECT 1 FROM handyman_fiscal_withholding_credits x
            JOIN handyman_fiscal_documents f ON f.id=x.document_id
            JOIN handyman_customer_transactions t ON t.id=NEW.transaction_id
            WHERE x.correction_id=NEW.id AND f.execution_scope_id=t.execution_scope_id)
        THEN RAISE EXCEPTION 'Ambiguous adjustment on a REDUCE requires explicit financial provenance.' USING ERRCODE='23514'; END IF;
        -- Existing correction laws cap line and transaction adjustments
        -- separately. On a REDUCE ledger their combined total must also
        -- remain within all posted charges, including for later, independently
        -- sourced credits. The existing ledger-row fence serializes writers.
        IF NEW.correction_kind='ADJUSTMENT'
          AND EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.transaction_id=NEW.transaction_id)
          AND (SELECT COALESCE(sum(c.amount),0) FROM handyman_ledger_corrections c
                 WHERE c.transaction_id=NEW.transaction_id AND c.correction_kind='ADJUSTMENT')
            > (SELECT COALESCE(sum(l.amount),0) FROM handyman_charge_lines l WHERE l.transaction_id=NEW.transaction_id)
        THEN RAISE EXCEPTION 'Adjustments would exceed the REDUCE transaction net charge.' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_reduce_adjustment_binding_required AFTER INSERT ON handyman_ledger_corrections
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_reduce_adjustment_binding_required();

      -- A newly finalized invoice cannot silently omit an already approved,
      -- authorized REDUCE awaiting its financial binding. This is a narrow
      -- ordering guard, not a tax/invoice calculation or schema change.
      -- The existing finalizer locks invoice then scope; use that same fence.
      CREATE FUNCTION hm_reduce_invoice_finalize_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='FINALIZED' AND OLD.status IS DISTINCT FROM 'FINALIZED'
          AND NEW.handyman_execution_scope_id IS NOT NULL THEN
          PERFORM 1 FROM handyman_execution_scopes WHERE id=NEW.handyman_execution_scope_id FOR SHARE;
          IF EXISTS (SELECT 1 FROM handyman_scope_variations v
            WHERE v.execution_scope_id=NEW.handyman_execution_scope_id AND v.client_id=NEW.client_id
              AND v.variation_type='REDUCE' AND v.tenant_decision_outcome='APPROVED'
              AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
              AND NOT EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.variation_id=v.id))
          THEN RAISE EXCEPTION 'An authorized REDUCE requires its financial binding before invoice finalization.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_reduce_invoice_finalize_guard BEFORE UPDATE OF status ON tenant_invoices
        FOR EACH ROW EXECUTE FUNCTION hm_reduce_invoice_finalize_guard();

      -- Allocation never rewrites a receipt. For a reduced line, future
      -- allocations cannot exceed its correction-netted charge; reversals
      -- continue to release prior allocations as in the existing ledger.
      CREATE FUNCTION hm_reduce_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE net NUMERIC; applied NUMERIC;
      BEGIN
        PERFORM 1 FROM handyman_customer_transactions WHERE id=NEW.transaction_id FOR UPDATE;
        IF EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.charge_line_id=NEW.charge_line_id) THEN
          IF current_setting('transaction_isolation') <> 'read committed' THEN
            RAISE EXCEPTION 'Reduced-line allocations require READ COMMITTED.' USING ERRCODE='23514'; END IF;
          SELECT l.amount-COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
            WHERE c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id=l.id),0)
            INTO net FROM handyman_charge_lines l WHERE l.id=NEW.charge_line_id;
          SELECT COALESCE(sum(a.amount),0) INTO applied FROM handyman_payment_allocations a
            WHERE a.charge_line_id=NEW.charge_line_id AND NOT EXISTS (
              SELECT 1 FROM handyman_ledger_corrections c WHERE c.correction_kind='REVERSAL' AND c.source_allocation_id=a.id);
          IF applied+NEW.amount>net THEN
            RAISE EXCEPTION 'Allocation exceeds the corrected REDUCE charge line.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER a_hm_reduce_allocation_guard BEFORE INSERT ON handyman_payment_allocations
        FOR EACH ROW EXECUTE FUNCTION hm_reduce_allocation_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_reduce_financial_corrections IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_reduce_financial_corrections) THEN
        RAISE EXCEPTION 'Cannot remove recorded REDUCE financial bindings.'; END IF; END $$;
      DROP TRIGGER hm_reduce_invoice_finalize_guard ON tenant_invoices;
      DROP FUNCTION hm_reduce_invoice_finalize_guard();
      DROP TRIGGER a_hm_reduce_allocation_guard ON handyman_payment_allocations;
      DROP FUNCTION hm_reduce_allocation_guard();
      DROP TRIGGER hm_reduce_adjustment_binding_required ON handyman_ledger_corrections;
      DROP FUNCTION hm_reduce_adjustment_binding_required();
      DROP TRIGGER hm_reduce_bound_variation_guard ON handyman_scope_variations;
      DROP FUNCTION hm_reduce_bound_variation_guard();
      DROP TABLE handyman_reduce_financial_corrections;
      DROP FUNCTION hm_reduce_financial_insert_guard();
      DROP FUNCTION hm_reduce_financial_immutable();
    `);
  },
};
