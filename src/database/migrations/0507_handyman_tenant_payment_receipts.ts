import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** The same logged PostgreSQL BYTEA/checksum/immutability contract as official BM PDFs. */
export const migration0507HandymanTenantPaymentReceipts: Migration = {
  id: '0507_handyman_tenant_payment_receipts',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_tenant_payment_receipts (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        transaction_id UUID NOT NULL REFERENCES handyman_customer_transactions(id),
        payment_id UUID NOT NULL REFERENCES handyman_customer_payments(id),
        record_event_id UUID NOT NULL REFERENCES handyman_customer_payment_events(id),
        confirmation_event_id UUID NOT NULL REFERENCES handyman_customer_payment_events(id),
        issuer_profile_id UUID NOT NULL REFERENCES handyman_document_issuer_profiles(id),
        issued_by_user_id UUID NOT NULL REFERENCES users(id),
        issued_at TIMESTAMPTZ NOT NULL, source_as_of TIMESTAMPTZ NOT NULL,
        source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
        source_canonical TEXT NOT NULL, source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename TEXT NOT NULL CHECK (pdf_filename ~ '^[a-z0-9-]+[.]pdf$'),
        pdf_bytes BYTEA NOT NULL, pdf_size INTEGER NOT NULL CHECK (pdf_size BETWEEN 1 AND 10485760 AND pdf_size=octet_length(pdf_bytes)),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_tenant_receipt_one_per_payment UNIQUE (payment_id),
        CHECK (issued_at >= source_as_of),
        CHECK (source_canonical::jsonb=source_snapshot),
        CHECK (source_sha256=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
        CHECK (pdf_sha256=encode(sha256(pdf_bytes),'hex')),
        CHECK (substring(pdf_bytes FROM 1 FOR 5)=decode('255044462d','hex')),
        CHECK (source_snapshot->>'schema' IS NOT DISTINCT FROM 'HANDYMAN_TENANT_PAYMENT_RECEIPT_V1'),
        CHECK (source_snapshot->>'status' IS NOT DISTINCT FROM 'ISSUED'),
        CHECK (source_snapshot#>>'{payer,basis}' IS NOT DISTINCT FROM 'EXECUTION_SCOPE_CUSTOMER'),
        CHECK (source_snapshot#>>'{payer,remitterIdentity}' IS NOT DISTINCT FROM 'NOT_VERIFIED'),
        CHECK (source_snapshot->>'clientId' IS NOT DISTINCT FROM client_id::text),
        CHECK (source_snapshot#>>'{building,id}' IS NOT DISTINCT FROM building_id::text),
        CHECK (source_snapshot#>>'{payer,tenantCompanyId}' IS NOT DISTINCT FROM tenant_company_id::text),
        CHECK (source_snapshot#>>'{reference,requestId}' IS NOT DISTINCT FROM request_id::text),
        CHECK (source_snapshot#>>'{reference,executionScopeId}' IS NOT DISTINCT FROM execution_scope_id::text),
        CHECK (source_snapshot#>>'{reference,transactionId}' IS NOT DISTINCT FROM transaction_id::text),
        CHECK (source_snapshot#>>'{payment,id}' IS NOT DISTINCT FROM payment_id::text),
        CHECK (source_snapshot#>>'{payment,recordEventId}' IS NOT DISTINCT FROM record_event_id::text),
        CHECK (source_snapshot#>>'{verification,confirmationEventId}' IS NOT DISTINCT FROM confirmation_event_id::text),
        CHECK (source_snapshot#>>'{issuer,profileId}' IS NOT DISTINCT FROM issuer_profile_id::text),
        CHECK (source_snapshot#>>'{issuance,id}' IS NOT DISTINCT FROM id::text),
        CHECK (source_snapshot#>>'{issuance,issuedByUserId}' IS NOT DISTINCT FROM issued_by_user_id::text),
        CHECK ((source_snapshot#>>'{issuance,issuedAt}')::timestamptz IS NOT DISTINCT FROM issued_at),
        CHECK ((source_snapshot->>'asOf')::timestamptz IS NOT DISTINCT FROM source_as_of),
        CHECK (jsonb_typeof(source_snapshot->'allocations')='array'),
        CHECK (jsonb_typeof(source_snapshot->'corrections')='array')
      );
      CREATE INDEX hm_tenant_receipt_scope_idx ON handyman_tenant_payment_receipts
        (client_id, building_id, execution_scope_id, payment_id);

      CREATE FUNCTION hm_tenant_receipt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n INTEGER; unique_n INTEGER;
      BEGIN
        -- An immutable CONFIRM_PAYMENT event is necessary, but self-confirmation
        -- alone is not independent. A distinct reconciler is an alternative.
        IF NOT EXISTS (
          SELECT 1 FROM handyman_customer_payments p
          JOIN handyman_customer_transactions t ON t.id=p.transaction_id AND t.client_id=p.client_id
          JOIN handyman_execution_scopes s ON s.id=t.execution_scope_id AND s.client_id=t.client_id
          JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id
            AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
            AND r.space_id IS NOT DISTINCT FROM s.space_id
          JOIN tenant_companies tc ON tc.id=s.tenant_company_id AND tc.client_id=s.client_id
          JOIN buildings b ON b.id=s.building_id
          JOIN properties prop ON prop.id=b.property_id AND prop.client_id=s.client_id
          JOIN handyman_customer_payment_events rec ON rec.id=NEW.record_event_id AND rec.payment_id=p.id
            AND rec.client_id=p.client_id AND rec.transaction_id=t.id AND rec.event_type='RECORD_PAYMENT'
            AND rec.actor_user_id=p.recorded_by_user_id
          JOIN handyman_customer_payment_events conf ON conf.id=NEW.confirmation_event_id AND conf.payment_id=p.id
            AND conf.client_id=p.client_id AND conf.transaction_id=t.id AND conf.event_type='CONFIRM_PAYMENT'
            AND conf.actor_user_id=p.decided_by_user_id
          JOIN handyman_document_issuer_profiles i ON i.id=NEW.issuer_profile_id AND i.client_id=p.client_id AND i.status='ACTIVE'
          WHERE p.id=NEW.payment_id AND p.status='CONFIRMED' AND p.decided_at IS NOT NULL
            AND t.id=NEW.transaction_id AND s.id=NEW.execution_scope_id AND r.id=NEW.request_id
            AND s.client_id=NEW.client_id AND s.building_id=NEW.building_id AND s.tenant_company_id=NEW.tenant_company_id
            AND ((p.decided_by_user_id<>p.recorded_by_user_id AND NEW.source_snapshot#>>'{verification,basis}'='INDEPENDENT_CONFIRMATION')
              OR (p.decided_by_user_id=p.recorded_by_user_id AND NEW.source_snapshot#>>'{verification,basis}'='INDEPENDENT_RECONCILIATION'
                AND EXISTS (SELECT 1 FROM handyman_payment_reconciliations pr WHERE pr.payment_id=p.id AND pr.client_id=p.client_id
                  AND pr.verified_by_user_id<>p.recorded_by_user_id
                  AND pr.id::text=NEW.source_snapshot#>>'{verification,reconciliation,id}')))
            AND p.amount=(NEW.source_snapshot#>>'{payment,amount}')::numeric
            AND p.currency=NEW.source_snapshot#>>'{payment,currency}'
            AND p.obligation_stage=NEW.source_snapshot#>>'{payment,obligationStage}'
            AND p.channel=NEW.source_snapshot#>>'{payment,channel}'
            AND p.provider_name IS NOT DISTINCT FROM NEW.source_snapshot#>>'{payment,providerName}'
            AND p.provider_reference IS NOT DISTINCT FROM NEW.source_snapshot#>>'{payment,providerReference}'
            AND p.external_reference IS NOT DISTINCT FROM NEW.source_snapshot#>>'{payment,externalReference}'
            AND p.received_at=(NEW.source_snapshot#>>'{payment,recordedAt}')::timestamptz
            AND rec.occurred_at=(NEW.source_snapshot#>>'{payment,recordEventOccurredAt}')::timestamptz
            AND conf.occurred_at=(NEW.source_snapshot#>>'{verification,confirmationEventOccurredAt}')::timestamptz
            AND p.decided_at=(NEW.source_snapshot#>>'{verification,confirmedAt}')::timestamptz
            AND p.recorded_by_user_id::text=NEW.source_snapshot#>>'{payment,recordedByUserId}'
            AND p.decided_by_user_id::text=NEW.source_snapshot#>>'{verification,confirmedByUserId}'
            AND t.quotation_version_id::text=NEW.source_snapshot#>>'{reference,quotationVersionId}'
            AND s.space_id::text IS NOT DISTINCT FROM NEW.source_snapshot#>>'{reference,spaceId}'
            AND b.name=NEW.source_snapshot#>>'{building,name}' AND b.code=NEW.source_snapshot#>>'{building,code}'
            AND tc.tenant_name=NEW.source_snapshot#>>'{payer,tenantName}'
            AND tc.legal_name IS NOT DISTINCT FROM NEW.source_snapshot#>>'{payer,legalName}'
            AND i.version=(NEW.source_snapshot#>>'{issuer,version}')::integer
            AND i.legal_name=NEW.source_snapshot#>>'{issuer,legalName}'
            AND i.display_name=NEW.source_snapshot#>>'{issuer,displayName}'
            AND i.registered_address=NEW.source_snapshot#>>'{issuer,registeredAddress}'
            AND i.business_address IS NOT DISTINCT FROM NEW.source_snapshot#>>'{issuer,businessAddress}'
            AND i.city=NEW.source_snapshot#>>'{issuer,city}' AND i.province=NEW.source_snapshot#>>'{issuer,province}'
            AND i.postal_code=NEW.source_snapshot#>>'{issuer,postalCode}'
            AND i.email=NEW.source_snapshot#>>'{issuer,email}' AND i.phone=NEW.source_snapshot#>>'{issuer,phone}'
            AND i.whatsapp=NEW.source_snapshot#>>'{issuer,whatsapp}'
            AND i.website IS NOT DISTINCT FROM NEW.source_snapshot#>>'{issuer,website}'
            AND i.tax_id IS NOT DISTINCT FROM NEW.source_snapshot#>>'{issuer,taxId}'
            AND i.business_registration_id IS NOT DISTINCT FROM NEW.source_snapshot#>>'{issuer,businessRegistrationId}'
            AND i.logo_reference IS NOT DISTINCT FROM NEW.source_snapshot#>>'{issuer,logoReference}'
        ) THEN
          RAISE EXCEPTION 'Receipt requires matching independently verified incoming payment and scope.' USING ERRCODE='23514';
        END IF;
        IF (SELECT count(*) FROM handyman_customer_payment_events WHERE payment_id=NEW.payment_id AND event_type='RECORD_PAYMENT')<>1
           OR (SELECT count(*) FROM handyman_customer_payment_events WHERE payment_id=NEW.payment_id AND event_type='CONFIRM_PAYMENT')<>1 THEN
          RAISE EXCEPTION 'Receipt requires unambiguous payment event provenance.' USING ERRCODE='23514';
        END IF;
        IF jsonb_typeof(NEW.source_snapshot#>'{verification,reconciliation}')='object' THEN
          IF NOT EXISTS (SELECT 1 FROM handyman_payment_reconciliations pr
            WHERE pr.id::text=NEW.source_snapshot#>>'{verification,reconciliation,id}' AND pr.payment_id=NEW.payment_id
              AND pr.client_id=NEW.client_id AND pr.bank_reference=NEW.source_snapshot#>>'{verification,reconciliation,bankReference}'
              AND pr.verified_by_user_id::text=NEW.source_snapshot#>>'{verification,reconciliation,verifiedByUserId}'
              AND pr.actual_received_at=(NEW.source_snapshot#>>'{verification,reconciliation,actualReceivedAt}')::timestamptz
              AND pr.verified_at=(NEW.source_snapshot#>>'{verification,reconciliation,verifiedAt}')::timestamptz) THEN
            RAISE EXCEPTION 'Receipt reconciliation pin does not match.' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.source_snapshot#>'{verification,reconciliation}'='null'::jsonb THEN
          IF EXISTS (SELECT 1 FROM handyman_payment_reconciliations WHERE payment_id=NEW.payment_id) THEN
            RAISE EXCEPTION 'Receipt omitted an existing payment reconciliation.' USING ERRCODE='23514';
          END IF;
        ELSE RAISE EXCEPTION 'Receipt reconciliation pin is invalid.' USING ERRCODE='23514';
        END IF;
        IF jsonb_typeof(NEW.source_snapshot#>'{reference,invoice}')='object' THEN
          IF NOT EXISTS (SELECT 1 FROM tenant_invoices i JOIN handyman_customer_transactions t ON t.id=NEW.transaction_id
            JOIN handyman_execution_scopes s ON s.id=NEW.execution_scope_id
            WHERE i.id::text=NEW.source_snapshot#>>'{reference,invoice,id}' AND i.handyman_execution_scope_id=s.id
              AND i.client_id=NEW.client_id AND i.building_id=NEW.building_id AND i.tenant_company_id=NEW.tenant_company_id
              AND i.space_id IS NOT DISTINCT FROM s.space_id AND i.currency_code=t.currency
              AND i.invoice_number=NEW.source_snapshot#>>'{reference,invoice,number}'
              AND i.status=NEW.source_snapshot#>>'{reference,invoice,status}') THEN
            RAISE EXCEPTION 'Receipt invoice reference does not match.' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.source_snapshot#>'{reference,invoice}'='null'::jsonb THEN
          IF EXISTS (SELECT 1 FROM tenant_invoices WHERE handyman_execution_scope_id=NEW.execution_scope_id) THEN
            RAISE EXCEPTION 'Receipt omitted an existing invoice reference.' USING ERRCODE='23514';
          END IF;
        ELSE RAISE EXCEPTION 'Receipt invoice reference is invalid.' USING ERRCODE='23514';
        END IF;
        SELECT count(*),count(DISTINCT x->>'id') INTO n,unique_n FROM jsonb_array_elements(NEW.source_snapshot->'allocations') x;
        IF n<>unique_n OR n<>(SELECT count(*) FROM handyman_payment_allocations a WHERE a.payment_id=NEW.payment_id)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'allocations') x
             WHERE NOT EXISTS (SELECT 1 FROM handyman_payment_allocations a WHERE a.id::text=x->>'id'
               AND a.payment_id=NEW.payment_id AND a.transaction_id=NEW.transaction_id
               AND a.charge_line_id::text=x->>'chargeLineId' AND a.line_kind=x->>'lineKind'
               AND a.currency=x->>'currency' AND a.amount=(x->>'amount')::numeric
               AND a.allocated_by_user_id::text=x->>'allocatedByUserId' AND a.occurred_at=(x->>'occurredAt')::timestamptz)) THEN
          RAISE EXCEPTION 'Receipt allocation snapshot is incomplete or inconsistent.' USING ERRCODE='23514';
        END IF;
        SELECT count(*),count(DISTINCT x->>'id') INTO n,unique_n FROM jsonb_array_elements(NEW.source_snapshot->'corrections') x;
        IF n<>unique_n OR n<>(SELECT count(*) FROM handyman_ledger_corrections c
              WHERE c.source_payment_id=NEW.payment_id OR c.source_allocation_id IN
                (SELECT a.id FROM handyman_payment_allocations a WHERE a.payment_id=NEW.payment_id))
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'corrections') x
             WHERE NOT EXISTS (SELECT 1 FROM handyman_ledger_corrections c WHERE c.id::text=x->>'id'
               AND c.transaction_id=NEW.transaction_id AND c.correction_kind=x->>'kind'
               AND c.source_kind=x->>'sourceKind' AND c.currency=x->>'currency' AND c.amount=(x->>'amount')::numeric
               AND coalesce(c.source_payment_id,c.source_allocation_id)::text=x->>'sourceId'
               AND c.corrected_by_user_id::text=x->>'correctedByUserId' AND c.occurred_at=(x->>'occurredAt')::timestamptz
               AND (c.source_payment_id=NEW.payment_id OR c.source_allocation_id IN
                 (SELECT a.id FROM handyman_payment_allocations a WHERE a.payment_id=NEW.payment_id)))) THEN
          RAISE EXCEPTION 'Receipt correction snapshot is incomplete or inconsistent.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_tenant_receipt_insert BEFORE INSERT ON handyman_tenant_payment_receipts
        FOR EACH ROW EXECUTE FUNCTION hm_tenant_receipt_insert_guard();
      CREATE FUNCTION hm_tenant_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- Empty-table maintenance is harmless; an issued receipt is never removed.
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_tenant_payment_receipts) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Issued tenant payment receipts are immutable and cannot be removed.' USING ERRCODE='23514';
      END $$;
      CREATE TRIGGER hm_tenant_receipt_no_mutation BEFORE UPDATE OR DELETE ON handyman_tenant_payment_receipts
        FOR EACH ROW EXECUTE FUNCTION hm_tenant_receipt_immutable();
      CREATE TRIGGER hm_tenant_receipt_no_truncate BEFORE TRUNCATE ON handyman_tenant_payment_receipts
        FOR EACH STATEMENT EXECUTE FUNCTION hm_tenant_receipt_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query('LOCK TABLE handyman_tenant_payment_receipts IN ACCESS EXCLUSIVE MODE');
    await tx.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_tenant_payment_receipts) THEN
      RAISE EXCEPTION 'Refusing to remove issued tenant payment receipts and durable artifacts.'; END IF; END $$`);
    await tx.query(`DROP TABLE handyman_tenant_payment_receipts;
      DROP FUNCTION hm_tenant_receipt_insert_guard(); DROP FUNCTION hm_tenant_receipt_immutable();`);
  },
};
