import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A variation offer is an artifact of the existing Operations transition, not an approval. */
export const migration0513HandymanVariationOfferDocuments: Migration = {
  id: '0513_handyman_variation_offer_documents',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_variation_offer_document_number_seq AS BIGINT;
      CREATE TABLE handyman_variation_offer_documents (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        variation_id UUID NOT NULL UNIQUE REFERENCES handyman_scope_variations(id),
        variation_version INTEGER NOT NULL CHECK (variation_version > 0),
        original_quotation_document_id UUID NOT NULL REFERENCES handyman_quotation_documents(id),
        revised_quotation_document_id UUID NOT NULL UNIQUE REFERENCES handyman_quotation_documents(id),
        revised_quotation_version_id UUID NOT NULL UNIQUE REFERENCES handyman_quotation_versions(id),
        document_number TEXT NOT NULL UNIQUE CHECK (document_number ~ '^[A-Z][A-Z0-9-]*-[0-9]+$'),
        issued_by_user_id UUID NOT NULL REFERENCES users(id),
        issued_at TIMESTAMPTZ NOT NULL,
        source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
        source_canonical TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename TEXT NOT NULL CHECK (pdf_filename ~ '^[a-z0-9-]+[.]pdf$'),
        pdf_bytes BYTEA NOT NULL,
        pdf_size INTEGER NOT NULL CHECK (pdf_size BETWEEN 1 AND 10485760 AND pdf_size=octet_length(pdf_bytes)),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        CHECK (source_canonical::jsonb=source_snapshot),
        CHECK (source_sha256=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
        CHECK (pdf_sha256=encode(sha256(pdf_bytes),'hex')),
        CHECK (substring(pdf_bytes FROM 1 FOR 5)=decode('255044462d','hex')),
        CHECK (source_snapshot->>'schema' IS NOT DISTINCT FROM 'HANDYMAN_VARIATION_OFFER_V1'),
        CHECK (source_snapshot->>'status' IS NOT DISTINCT FROM 'ISSUED'),
        CHECK (source_snapshot->>'clientId' IS NOT DISTINCT FROM client_id::text),
        CHECK (source_snapshot->>'requestId' IS NOT DISTINCT FROM request_id::text),
        CHECK (source_snapshot->>'executionScopeId' IS NOT DISTINCT FROM execution_scope_id::text),
        CHECK (source_snapshot#>>'{variation,id}' IS NOT DISTINCT FROM variation_id::text),
        CHECK (source_snapshot#>>'{variation,version}' IS NOT DISTINCT FROM variation_version::text),
        CHECK (source_snapshot#>>'{variation,revisedQuotationVersionId}' IS NOT DISTINCT FROM revised_quotation_version_id::text),
        CHECK (source_snapshot#>>'{originalReference,id}' IS NOT DISTINCT FROM original_quotation_document_id::text),
        CHECK (source_snapshot#>>'{revisedReference,id}' IS NOT DISTINCT FROM revised_quotation_document_id::text),
        CHECK (source_snapshot#>>'{issuance,id}' IS NOT DISTINCT FROM id::text),
        CHECK (source_snapshot#>>'{issuance,number}' IS NOT DISTINCT FROM document_number),
        CHECK (source_snapshot#>>'{issuance,actorUserId}' IS NOT DISTINCT FROM issued_by_user_id::text),
        CHECK ((source_snapshot#>>'{issuance,issuedAt}')::timestamptz IS NOT DISTINCT FROM issued_at)
      );
      CREATE INDEX hm_variation_offer_request_idx ON handyman_variation_offer_documents(client_id,request_id,variation_id);

      -- No backdating or backfilling historical pending/approved variations.
      -- Both quotation snapshots are the previously issued official artifacts.
      CREATE FUNCTION hm_variation_offer_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_scope_variations v
          JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id AND s.client_id=v.client_id
          JOIN handyman_quotation_versions qv ON qv.id=v.revised_quotation_version_id AND qv.quotation_id=s.quotation_id
          JOIN handyman_quotation_documents o ON o.id=NEW.original_quotation_document_id
            AND o.quotation_version_id=s.approved_quotation_version_id AND o.quotation_id=s.quotation_id
            AND o.client_id=s.client_id AND o.request_id=s.handyman_request_id
          JOIN handyman_quotation_documents r ON r.id=NEW.revised_quotation_document_id
            AND r.quotation_version_id=qv.id AND r.quotation_id=s.quotation_id
            AND r.client_id=s.client_id AND r.request_id=s.handyman_request_id
          WHERE v.id=NEW.variation_id AND v.client_id=NEW.client_id AND s.id=NEW.execution_scope_id
            AND s.handyman_request_id=NEW.request_id AND v.status='REVISED_QUOTATION'
            AND v.tenant_decision_outcome IS NULL AND v.version=NEW.variation_version
            AND v.xmin=(pg_current_xact_id()::text)::xid
            AND qv.id=NEW.revised_quotation_version_id AND qv.status='ISSUED'
            AND qv.valid_until IS NOT NULL AND qv.valid_until>clock_timestamp()
            AND NEW.source_snapshot->'original'=o.source_snapshot AND NEW.source_snapshot->'revised'=r.source_snapshot
            AND NEW.source_snapshot#>>'{originalReference,number}'=o.document_number
            AND NEW.source_snapshot#>>'{originalReference,pdfSha256}'=o.pdf_sha256
            AND NEW.source_snapshot#>>'{originalReference,sourceSha256}'=o.source_sha256
            AND NEW.source_snapshot#>>'{revisedReference,number}'=r.document_number
            AND NEW.source_snapshot#>>'{revisedReference,pdfSha256}'=r.pdf_sha256
            AND NEW.source_snapshot#>>'{revisedReference,sourceSha256}'=r.source_sha256
            AND NEW.source_snapshot#>>'{variation,variationType}'=v.variation_type
            AND NEW.source_snapshot#>>'{variation,lineType}'=v.line_type
            AND NEW.source_snapshot#>>'{variation,targetQuotationLineId}' IS NOT DISTINCT FROM v.target_quotation_line_id::text
            AND NEW.source_snapshot#>>'{variation,title}'=v.title
            AND NEW.source_snapshot#>>'{variation,description}'=v.description
            AND NEW.source_snapshot#>>'{variation,technicalFinding}'=v.technical_finding
            AND (NEW.source_snapshot#>>'{variation,quantity}')::numeric=v.quantity
            AND NEW.source_snapshot#>>'{variation,uomId}'=v.uom_id::text
            AND (NEW.source_snapshot#>>'{variation,quotedUnitAmount}')::numeric=v.quoted_unit_amount
            AND (NEW.source_snapshot#>>'{variation,quotedTotalDelta}')::numeric=v.quoted_total_delta
            AND NEW.source_snapshot#>>'{variation,currency}'=v.currency
        ) THEN
          RAISE EXCEPTION 'Variation offer requires the exact newly issued variation and both official quotation documents.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_variation_offer_insert_guard BEFORE INSERT ON handyman_variation_offer_documents
        FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_insert_guard();

      CREATE FUNCTION hm_variation_offer_requires_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_scope_variation_events e
          WHERE e.variation_id=NEW.variation_id AND e.execution_scope_id=NEW.execution_scope_id
            AND e.event_type='REVISED_QUOTATION' AND e.actor_role='OPERATIONS_MANAGER'
            AND e.actor_user_id=NEW.issued_by_user_id
            AND e.metadata->>'revisedQuotationVersionId'=NEW.revised_quotation_version_id::text
            AND e.metadata#>>'{offerDocument,id}'=NEW.id::text
            AND e.metadata#>>'{offerDocument,version}'=NEW.variation_version::text
            AND e.metadata#>>'{offerDocument,pdfSha256}'=NEW.pdf_sha256
            AND e.metadata#>>'{offerDocument,sourceSha256}'=NEW.source_sha256
            AND e.metadata->>'revisedQuotationLineId' IS NOT DISTINCT FROM NEW.source_snapshot#>>'{variation,revisedQuotationLineId}'
            AND e.metadata->>'workOrderId' IS NOT DISTINCT FROM NEW.source_snapshot#>>'{variation,workOrderId}'
        ) THEN
          RAISE EXCEPTION 'Variation offer and its Operations event must be committed together.' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_variation_offer_requires_event AFTER INSERT ON handyman_variation_offer_documents
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_requires_event();

      CREATE FUNCTION hm_variation_revision_requires_offer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_variation_offer_documents d
          WHERE d.variation_id=NEW.id AND d.execution_scope_id=NEW.execution_scope_id
            AND d.variation_version=NEW.version AND d.revised_quotation_version_id=NEW.revised_quotation_version_id) THEN
          RAISE EXCEPTION 'A new variation offer requires its official immutable PDF in the same transaction.' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_variation_revision_requires_offer AFTER UPDATE ON handyman_scope_variations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (OLD.status='OPERATIONS_REVIEW' AND NEW.status='REVISED_QUOTATION')
        EXECUTE FUNCTION hm_variation_revision_requires_offer();

      CREATE FUNCTION hm_variation_offer_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type='TENANT_DECISION' AND NOT EXISTS (
          SELECT 1 FROM handyman_variation_offer_documents d
          JOIN handyman_scope_variation_events r ON r.variation_id=d.variation_id AND r.event_type='REVISED_QUOTATION'
            AND r.actor_role='OPERATIONS_MANAGER' AND r.metadata#>>'{offerDocument,id}'=d.id::text
            AND r.metadata#>>'{offerDocument,pdfSha256}'=d.pdf_sha256
          WHERE d.variation_id=NEW.variation_id AND d.execution_scope_id=NEW.execution_scope_id
            AND NEW.actor_role='TENANT'
            AND NEW.metadata#>>'{consentSnapshot,offerDocumentId}'=d.id::text
            AND NEW.metadata#>>'{consentSnapshot,offerDocumentVersion}'=d.variation_version::text
            AND NEW.metadata#>>'{consentSnapshot,offerPdfSha256}'=d.pdf_sha256
            AND NEW.metadata#>>'{consentSnapshot,revisedQuotationVersionId}'=d.revised_quotation_version_id::text
        ) THEN
          RAISE EXCEPTION 'New Tenant decisions require the exact issued variation PDF and version.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_variation_offer_decision_guard BEFORE INSERT ON handyman_scope_variation_events
        FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_decision_guard();

      CREATE FUNCTION hm_variation_offer_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_variation_offer_documents d WHERE d.variation_id=OLD.id) AND (
          NEW.variation_type IS DISTINCT FROM OLD.variation_type OR NEW.line_type IS DISTINCT FROM OLD.line_type OR
          NEW.target_quotation_line_id IS DISTINCT FROM OLD.target_quotation_line_id OR
          NEW.revised_quotation_version_id IS DISTINCT FROM OLD.revised_quotation_version_id OR
          NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description OR
          NEW.technical_finding IS DISTINCT FROM OLD.technical_finding OR NEW.quantity IS DISTINCT FROM OLD.quantity OR
          NEW.uom_id IS DISTINCT FROM OLD.uom_id OR NEW.quoted_unit_amount IS DISTINCT FROM OLD.quoted_unit_amount OR
          NEW.quoted_total_delta IS DISTINCT FROM OLD.quoted_total_delta OR NEW.currency IS DISTINCT FROM OLD.currency
        ) THEN
          RAISE EXCEPTION 'Issued variation offer terms are immutable; issue a new governed variation.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_variation_offer_terms_immutable BEFORE UPDATE ON handyman_scope_variations
        FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_terms_immutable();

      CREATE FUNCTION hm_variation_offer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_variation_offer_documents) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Issued variation offer documents are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_variation_offer_no_write BEFORE UPDATE OR DELETE ON handyman_variation_offer_documents
        FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_immutable();
      CREATE TRIGGER hm_variation_offer_no_truncate BEFORE TRUNCATE ON handyman_variation_offer_documents
        FOR EACH STATEMENT EXECUTE FUNCTION hm_variation_offer_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_variation_offer_documents IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_variation_offer_documents) THEN
        RAISE EXCEPTION 'Refusing to remove issued variation offer documents.'; END IF; END $$;
      DROP TRIGGER hm_variation_offer_terms_immutable ON handyman_scope_variations;
      DROP FUNCTION hm_variation_offer_terms_immutable();
      DROP TRIGGER hm_variation_offer_decision_guard ON handyman_scope_variation_events;
      DROP FUNCTION hm_variation_offer_decision_guard();
      DROP TRIGGER hm_variation_revision_requires_offer ON handyman_scope_variations;
      DROP FUNCTION hm_variation_revision_requires_offer();
      DROP TABLE handyman_variation_offer_documents;
      DROP FUNCTION hm_variation_offer_insert_guard();
      DROP FUNCTION hm_variation_offer_requires_event();
      DROP FUNCTION hm_variation_offer_immutable();
      DROP SEQUENCE handyman_variation_offer_document_number_seq;
    `);
  },
};
