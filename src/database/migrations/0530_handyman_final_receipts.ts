import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A final receipt is an immutable as-of document, never a new payment. */
export const migration0530HandymanFinalReceipts: Migration = {
  id: '0530_handyman_final_receipts',
  async up(tx:PoolClient):Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_final_receipt_number_seq;
      CREATE TABLE handyman_final_receipts (
        id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ISSUED' CHECK(status='ISSUED'),
        document_number text NOT NULL UNIQUE CHECK(document_number ~ '^FRC-[0-9]{10,}$'),
        invoice_id uuid NOT NULL UNIQUE REFERENCES handyman_official_invoices(id),
        transaction_id uuid NOT NULL REFERENCES handyman_customer_transactions(id),
        execution_scope_id uuid NOT NULL REFERENCES handyman_execution_scopes(id),
        client_id uuid NOT NULL REFERENCES clients(id), building_id uuid NOT NULL REFERENCES buildings(id),
        request_id uuid NOT NULL REFERENCES handyman_service_requests(id), tenant_company_id uuid NOT NULL REFERENCES tenant_companies(id),
        issued_by_user_id uuid NOT NULL REFERENCES users(id), issued_session_id uuid NOT NULL REFERENCES user_sessions(id),
        issued_at timestamptz NOT NULL, settled_at timestamptz NOT NULL,
        currency varchar(3) NOT NULL CHECK(currency='IDR'), invoice_total numeric(18,2) NOT NULL CHECK(invoice_total>0),
        settled_total numeric(18,2) NOT NULL, remaining_amount numeric(18,2) NOT NULL CHECK(remaining_amount=0),
        source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'), source_canonical text NOT NULL,
        source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename text NOT NULL CHECK(pdf_filename ~ '^final-receipt-frc-[0-9]+[.]pdf$'), pdf_bytes bytea NOT NULL,
        pdf_size integer NOT NULL CHECK(pdf_size BETWEEN 1 AND 10485760 AND pdf_size=octet_length(pdf_bytes)),
        pdf_sha256 text NOT NULL CHECK(pdf_sha256 ~ '^[0-9a-f]{64}$'),
        CHECK(issued_at>=settled_at AND settled_total=invoice_total),
        CHECK(source_snapshot=source_canonical::jsonb AND source_sha256=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
        CHECK(pdf_sha256=encode(sha256(pdf_bytes),'hex') AND substring(pdf_bytes FROM 1 FOR 5)=convert_to('%PDF-','UTF8')),
        CHECK(source_snapshot->>'schema' IS NOT DISTINCT FROM 'HANDYMAN_FINAL_RECEIPT_V1'),
        CHECK(source_snapshot->>'status' IS NOT DISTINCT FROM 'ISSUED'),
        CHECK(source_snapshot#>>'{issuance,id}' IS NOT DISTINCT FROM id::text),
        CHECK(source_snapshot#>>'{issuance,number}' IS NOT DISTINCT FROM document_number),
        CHECK(source_snapshot#>>'{issuance,actorUserId}' IS NOT DISTINCT FROM issued_by_user_id::text),
        CHECK((source_snapshot#>>'{issuance,issuedAt}')::timestamptz IS NOT DISTINCT FROM issued_at),
        CHECK((source_snapshot#>>'{settlement,settledAt}')::timestamptz IS NOT DISTINCT FROM settled_at),
        CHECK(source_snapshot#>>'{invoice,id}' IS NOT DISTINCT FROM invoice_id::text),
        CHECK(source_snapshot#>>'{scope,executionScopeId}' IS NOT DISTINCT FROM execution_scope_id::text),
        CHECK(source_snapshot#>>'{scope,transactionId}' IS NOT DISTINCT FROM transaction_id::text),
        CHECK(source_snapshot#>>'{scope,clientId}' IS NOT DISTINCT FROM client_id::text),
        CHECK(source_snapshot#>>'{scope,buildingId}' IS NOT DISTINCT FROM building_id::text),
        CHECK(source_snapshot#>>'{scope,requestId}' IS NOT DISTINCT FROM request_id::text),
        CHECK(source_snapshot#>>'{scope,tenantCompanyId}' IS NOT DISTINCT FROM tenant_company_id::text),
        CHECK(source_snapshot#>>'{settlement,currency}' IS NOT DISTINCT FROM currency),
        CHECK((source_snapshot#>>'{settlement,invoiceTotal}')::numeric IS NOT DISTINCT FROM invoice_total),
        CHECK((source_snapshot#>>'{settlement,totalSettled}')::numeric IS NOT DISTINCT FROM settled_total),
        CHECK((source_snapshot#>>'{settlement,remaining}')::numeric IS NOT DISTINCT FROM remaining_amount),
        CHECK(jsonb_typeof(source_snapshot->'payments')='array'),
        CHECK(jsonb_typeof(source_snapshot->'corrections')='array')
      );
      CREATE INDEX hm_final_receipt_care_scope ON handyman_final_receipts(client_id,building_id,request_id,invoice_id);

      -- Serialize all source writers with issuance on the existing ledger
      -- anchor. These locks do not freeze or alter later Finance lifecycles.
      CREATE FUNCTION hm_final_receipt_money_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ledger uuid;
      BEGIN
        IF TG_TABLE_NAME IN ('handyman_official_invoice_payment_links','handyman_payment_reconciliations') THEN
          SELECT transaction_id INTO ledger FROM handyman_customer_payments WHERE id=NEW.payment_id;
        ELSE ledger:=NEW.transaction_id; END IF;
        PERFORM id FROM handyman_customer_transactions WHERE id=ledger FOR UPDATE;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER a_hm_final_lock_payment BEFORE INSERT OR UPDATE ON handyman_customer_payments
        FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_money_lock();
      CREATE TRIGGER a_hm_final_lock_allocation BEFORE INSERT ON handyman_payment_allocations
        FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_money_lock();
      CREATE TRIGGER a_hm_final_lock_correction BEFORE INSERT ON handyman_ledger_corrections
        FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_money_lock();
      CREATE TRIGGER a_hm_final_lock_link BEFORE INSERT ON handyman_official_invoice_payment_links
        FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_money_lock();
      CREATE TRIGGER a_hm_final_lock_reconciliation BEFORE INSERT ON handyman_payment_reconciliations
        FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_money_lock();
      CREATE TRIGGER a_hm_final_lock_payment_receipt BEFORE INSERT ON handyman_tenant_payment_receipts
        FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_money_lock();

      CREATE FUNCTION hm_final_receipt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE inv handyman_official_invoices%ROWTYPE; n integer; distinct_n integer;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Final receipt reconciliation requires READ COMMITTED.' USING ERRCODE='23514'; END IF;
        PERFORM id FROM handyman_customer_transactions WHERE id=NEW.transaction_id FOR UPDATE;
        SELECT * INTO inv FROM handyman_official_invoices WHERE id=NEW.invoice_id;
        IF inv.id IS NULL OR (inv.transaction_id,inv.execution_scope_id,inv.client_id,inv.building_id,inv.request_id,inv.tenant_company_id,inv.currency,inv.total_amount)
          IS DISTINCT FROM (NEW.transaction_id,NEW.execution_scope_id,NEW.client_id,NEW.building_id,NEW.request_id,NEW.tenant_company_id,NEW.currency,NEW.invoice_total)
          OR NEW.source_snapshot#>>'{invoice,number}' IS DISTINCT FROM inv.document_number
          OR NEW.source_snapshot#>>'{invoice,sourceSha256}' IS DISTINCT FROM inv.source_sha256
          OR NEW.source_snapshot#>>'{invoice,pdfSha256}' IS DISTINCT FROM inv.pdf_sha256
          OR NEW.source_snapshot#>>'{invoice,classificationId}' IS DISTINCT FROM inv.classification_id::text
          OR NEW.source_snapshot->'issuer' IS DISTINCT FROM inv.source_snapshot->'issuer'
          OR NEW.source_snapshot#>>'{tenant,name}' IS DISTINCT FROM inv.source_snapshot#>>'{quotation,snapshot,customer,tenantName}'
          OR NEW.source_snapshot#>>'{tenant,legalName}' IS DISTINCT FROM inv.source_snapshot#>>'{quotation,snapshot,customer,legalName}'
          OR NEW.source_snapshot#>>'{tenant,buildingName}' IS DISTINCT FROM inv.source_snapshot#>>'{quotation,snapshot,customer,buildingName}'
          OR NEW.source_snapshot#>>'{issuance,actorName}' IS DISTINCT FROM (SELECT display_name FROM users WHERE id=NEW.issued_by_user_id)
          OR NEW.source_snapshot#>'{invoice,lines}' IS DISTINCT FROM inv.source_snapshot#>'{calculation,commercialSource,lines}'
          OR NEW.source_snapshot#>'{invoice,additions}' IS DISTINCT FROM inv.source_snapshot#>'{calculation,commercialSource,additions}'
          OR NOT EXISTS (SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id AND u.status='ACTIVE'
            JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=NEW.building_id AND a.status='ACTIVE'
            JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
            JOIN properties pr ON pr.id=b.property_id AND pr.client_id=NEW.client_id
            JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
            JOIN roles role ON role.id=ura.role_id AND role.status='ACTIVE'
            JOIN role_permission_assignments rpa ON rpa.role_id=role.id AND rpa.status='ACTIVE'
            JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE' AND perm.code='handyman.finance.manage'
            WHERE s.id=NEW.issued_session_id AND s.user_id=NEW.issued_by_user_id AND s.status='ACTIVE' AND s.expires_at>clock_timestamp())
          OR NOT EXISTS (SELECT 1 FROM handyman_official_invoice_payment_status p WHERE p.invoice_id=inv.id AND p.status='PAID'
            AND p.outstanding_amount=0 AND p.applied_amount=inv.total_amount AND p.verified_received_amount=inv.total_amount
            AND p.unallocated_verified_amount=0 AND p.excess_funds_amount=0 AND p.unlinked_verified_count=0 AND p.unlinked_allocation_amount=0)
          OR EXISTS (SELECT 1 FROM handyman_customer_payments p WHERE p.transaction_id=inv.transaction_id AND p.status='PENDING')
          -- Refund records have no independently verifiable outbound settlement
          -- state in this ledger. Do not assert that a refund has cleared.
          OR EXISTS (SELECT 1 FROM handyman_ledger_corrections c WHERE c.transaction_id=inv.transaction_id AND c.correction_kind='REFUND')
        THEN RAISE EXCEPTION 'Final receipt requires an exact fully settled invoice, active issuer and no unresolved funds or refund.' USING ERRCODE='23514'; END IF;
        SELECT count(*),count(DISTINCT j->>'variationId') INTO n,distinct_n
          FROM jsonb_array_elements(NEW.source_snapshot#>'{invoice,variations}') j;
        IF n<>distinct_n OR n<>jsonb_array_length(inv.source_snapshot->'variations') OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot#>'{invoice,variations}') j WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(inv.source_snapshot->'variations') v
              WHERE v->>'variationId'=j->>'variationId' AND v->>'number'=j->>'number'
                AND v->>'version'=j->>'version' AND v->>'sourceSha256'=j->>'sourceSha256' AND v->>'pdfSha256'=j->>'pdfSha256'))
        THEN RAISE EXCEPTION 'Final receipt must pin the exact approved invoice variation documents.' USING ERRCODE='23514'; END IF;
        IF NEW.settled_at IS DISTINCT FROM date_trunc('milliseconds',greatest(inv.issued_at,
          coalesce((SELECT max(p.decided_at) FROM handyman_customer_payments p WHERE p.transaction_id=inv.transaction_id
            AND EXISTS (SELECT 1 FROM handyman_payment_allocations a WHERE a.payment_id=p.id AND NOT EXISTS (
              SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))),inv.issued_at),
          coalesce((SELECT max(a.occurred_at) FROM handyman_payment_allocations a WHERE a.transaction_id=inv.transaction_id AND NOT EXISTS (
            SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id)),inv.issued_at),
          coalesce((SELECT max(l.linked_at) FROM handyman_official_invoice_payment_links l WHERE l.invoice_id=inv.id AND EXISTS (
            SELECT 1 FROM handyman_payment_allocations a WHERE a.payment_id=l.payment_id AND NOT EXISTS (
              SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))),inv.issued_at),
          coalesce((SELECT max(rec.verified_at) FROM handyman_payment_reconciliations rec WHERE EXISTS (
            SELECT 1 FROM handyman_payment_allocations a WHERE a.payment_id=rec.payment_id AND a.transaction_id=inv.transaction_id AND NOT EXISTS (
              SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))),inv.issued_at),
          coalesce((SELECT max(c.occurred_at) FROM handyman_ledger_corrections c WHERE c.transaction_id=inv.transaction_id),inv.issued_at)))
        THEN RAISE EXCEPTION 'Final settlement date must match the recorded invoice, payment and correction facts.' USING ERRCODE='23514'; END IF;
        -- Every adjustment must be the already approved REDUCE pinned into
        -- the frozen invoice. A later adjustment needs a governed correction.
        IF EXISTS (SELECT 1 FROM handyman_ledger_corrections c WHERE c.transaction_id=inv.transaction_id AND c.correction_kind='ADJUSTMENT'
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv.source_snapshot#>'{calculation,commercialSource,lines}') l,
            jsonb_array_elements(l->'reductions') red WHERE red->>'correctionId'=c.id::text))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(inv.source_snapshot#>'{calculation,commercialSource,lines}') l,
            jsonb_array_elements(l->'reductions') red WHERE red->>'correctionId' IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM handyman_reduce_financial_corrections b JOIN handyman_ledger_corrections c ON c.id=b.correction_id
              WHERE b.id::text=red->>'bindingId' AND b.correction_id::text=red->>'correctionId'
                AND b.variation_id::text=red->>'variationId' AND b.transaction_id=inv.transaction_id
                AND b.charge_line_id::text=l->>'chargeLineId' AND -b.signed_amount=(red->>'amount')::numeric
                AND c.correction_kind='ADJUSTMENT' AND c.amount=(red->>'amount')::numeric))
        THEN RAISE EXCEPTION 'An invoice correction is unresolved or does not match its approved source.' USING ERRCODE='23514'; END IF;
        -- No active allocation may be duplicated, unlinked or lack an
        -- independently verified, separately issued Payment Receipt.
        SELECT count(*),count(DISTINCT p->>'paymentId') INTO n,distinct_n FROM jsonb_array_elements(NEW.source_snapshot->'payments') p;
        IF n<>distinct_n OR n<>(SELECT count(DISTINCT a.payment_id) FROM handyman_payment_allocations a
            WHERE a.transaction_id=inv.transaction_id AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections x
              WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'payments') j WHERE NOT EXISTS (
            SELECT 1 FROM handyman_customer_payments p JOIN handyman_official_invoice_payment_links l ON l.payment_id=p.id AND l.invoice_id=inv.id
            JOIN handyman_tenant_payment_receipts r ON r.payment_id=p.id AND r.transaction_id=inv.transaction_id
              AND r.execution_scope_id=inv.execution_scope_id AND r.client_id=inv.client_id AND r.building_id=inv.building_id
              AND r.tenant_company_id=inv.tenant_company_id AND r.request_id=inv.request_id
            JOIN handyman_customer_payment_events e ON e.id=r.confirmation_event_id AND e.payment_id=p.id AND e.event_type='CONFIRM_PAYMENT'
              AND e.actor_user_id=p.decided_by_user_id
            WHERE p.id::text=j->>'paymentId' AND p.status='CONFIRMED' AND p.transaction_id=inv.transaction_id AND p.currency=inv.currency
              AND p.amount=(j->>'amount')::numeric AND p.obligation_stage=j->>'stage'
              AND r.id::text=j->>'receiptId' AND r.source_sha256=j->>'receiptSourceSha256' AND r.pdf_sha256=j->>'receiptPdfSha256'
              AND e.id::text=j->>'confirmationEventId'
              AND (p.decided_by_user_id<>p.recorded_by_user_id OR EXISTS (SELECT 1 FROM handyman_payment_reconciliations rec
                WHERE rec.payment_id=p.id AND rec.client_id=p.client_id AND rec.verified_by_user_id<>p.recorded_by_user_id))
              AND (SELECT coalesce(sum(a.amount),0) FROM handyman_payment_allocations a WHERE a.payment_id=p.id
                AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))=p.amount
              AND p.amount=(j->>'allocatedAmount')::numeric))
        THEN RAISE EXCEPTION 'Final receipt requires every exact independently verified payment and its separately issued receipt.' USING ERRCODE='23514'; END IF;
        SELECT count(*),count(DISTINCT a->>'id') INTO n,distinct_n FROM jsonb_array_elements(NEW.source_snapshot->'payments') p,
          jsonb_array_elements(p->'allocations') a;
        IF n<>distinct_n OR n<>(SELECT count(*) FROM handyman_payment_allocations a WHERE a.transaction_id=inv.transaction_id
              AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'payments') p,jsonb_array_elements(p->'allocations') j
            WHERE NOT EXISTS (SELECT 1 FROM handyman_payment_allocations a WHERE a.id::text=j->>'id'
              AND a.transaction_id=inv.transaction_id AND a.payment_id::text=p->>'paymentId'
              AND a.charge_line_id::text=j->>'chargeLineId' AND a.amount=(j->>'amount')::numeric
              AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id)))
          OR EXISTS (SELECT 1 FROM handyman_payment_allocations a WHERE a.transaction_id=inv.transaction_id
            AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id)
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv.source_snapshot#>'{calculation,commercialSource,lines}') l
              WHERE l->>'chargeLineId'=a.charge_line_id::text))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(inv.source_snapshot#>'{calculation,commercialSource,lines}') l
            WHERE (l->>'grossAmount')::numeric<>(SELECT coalesce(sum(a.amount),0) FROM handyman_payment_allocations a
              WHERE a.transaction_id=inv.transaction_id AND a.charge_line_id::text=l->>'chargeLineId'
                AND NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections x WHERE x.correction_kind='REVERSAL' AND x.source_allocation_id=a.id)))
        THEN RAISE EXCEPTION 'Final receipt allocation snapshot is incomplete, duplicated or not settled per invoice line.' USING ERRCODE='23514'; END IF;
        SELECT count(*),count(DISTINCT j->>'id') INTO n,distinct_n FROM jsonb_array_elements(NEW.source_snapshot->'corrections') j;
        IF n<>distinct_n OR n<>(SELECT count(*) FROM handyman_ledger_corrections WHERE transaction_id=inv.transaction_id)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'corrections') j WHERE NOT EXISTS (
            SELECT 1 FROM handyman_ledger_corrections c WHERE c.id::text=j->>'id' AND c.transaction_id=inv.transaction_id
              AND c.correction_kind=j->>'kind' AND c.source_kind=j->>'sourceKind' AND c.currency=j->>'currency'
              AND coalesce(c.source_payment_id,c.source_allocation_id,c.source_charge_line_id)::text IS NOT DISTINCT FROM j->>'sourceId'
              AND c.amount=(j->>'amount')::numeric AND c.corrected_by_user_id::text=j->>'actorUserId'
              AND c.occurred_at=(j->>'occurredAt')::timestamptz))
        THEN RAISE EXCEPTION 'Final receipt correction history is incomplete or inconsistent.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_final_receipt_issue BEFORE INSERT ON handyman_final_receipts FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_insert_guard();
      CREATE FUNCTION hm_final_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM handyman_final_receipts) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Issued final receipts are immutable.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_final_receipt_no_mutation BEFORE UPDATE OR DELETE ON handyman_final_receipts FOR EACH ROW EXECUTE FUNCTION hm_final_receipt_immutable();
      CREATE TRIGGER hm_final_receipt_no_truncate BEFORE TRUNCATE ON handyman_final_receipts FOR EACH STATEMENT EXECUTE FUNCTION hm_final_receipt_immutable();
    `);
  },
  async down(tx:PoolClient):Promise<void> {
    await tx.query(`LOCK TABLE handyman_final_receipts IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_final_receipts) THEN RAISE EXCEPTION 'Cannot discard issued final receipts.'; END IF; END $$;
      DROP TRIGGER a_hm_final_lock_payment ON handyman_customer_payments;
      DROP TRIGGER a_hm_final_lock_allocation ON handyman_payment_allocations;
      DROP TRIGGER a_hm_final_lock_correction ON handyman_ledger_corrections;
      DROP TRIGGER a_hm_final_lock_link ON handyman_official_invoice_payment_links;
      DROP TRIGGER a_hm_final_lock_reconciliation ON handyman_payment_reconciliations;
      DROP TRIGGER a_hm_final_lock_payment_receipt ON handyman_tenant_payment_receipts;
      DROP TRIGGER hm_final_receipt_issue ON handyman_final_receipts;
      DROP TRIGGER hm_final_receipt_no_mutation ON handyman_final_receipts;
      DROP TRIGGER hm_final_receipt_no_truncate ON handyman_final_receipts;
      DROP FUNCTION hm_final_receipt_money_lock(),hm_final_receipt_insert_guard(),hm_final_receipt_immutable();
      DROP TABLE handyman_final_receipts;
      DROP SEQUENCE handyman_final_receipt_number_seq;`);
  },
};
