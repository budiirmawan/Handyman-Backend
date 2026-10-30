import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Official quotation artifacts belong to the existing quotation ISSUE, not a second lifecycle. */
export const migration0509HandymanQuotationDocuments: Migration = {
  id: '0509_handyman_quotation_documents',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_quotation_document_number_seq AS BIGINT;
      CREATE TABLE handyman_quotation_documents (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        quotation_id UUID NOT NULL REFERENCES handyman_quotations(id),
        quotation_version_id UUID NOT NULL UNIQUE REFERENCES handyman_quotation_versions(id),
        document_number TEXT NOT NULL UNIQUE CHECK (document_number ~ '^[A-Z][A-Z0-9-]*-[0-9]+$'),
        issuer_profile_id UUID NOT NULL REFERENCES handyman_document_issuer_profiles(id),
        bank_version_id UUID NOT NULL REFERENCES handyman_document_issuer_bank_accounts(id),
        settings_id UUID NOT NULL REFERENCES handyman_document_issuer_document_settings(id),
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
        CHECK (source_snapshot->>'schema' IS NOT DISTINCT FROM 'HANDYMAN_QUOTATION_DOCUMENT_V1'),
        CHECK (source_snapshot->>'status' IS NOT DISTINCT FROM 'ISSUED'),
        CHECK (source_snapshot->>'clientId' IS NOT DISTINCT FROM client_id::text),
        CHECK (source_snapshot#>>'{customer,requestId}' IS NOT DISTINCT FROM request_id::text),
        CHECK (source_snapshot#>>'{quotation,id}' IS NOT DISTINCT FROM quotation_id::text),
        CHECK (source_snapshot#>>'{quotation,versionId}' IS NOT DISTINCT FROM quotation_version_id::text),
        CHECK (source_snapshot#>>'{issuance,id}' IS NOT DISTINCT FROM id::text),
        CHECK (source_snapshot#>>'{issuance,number}' IS NOT DISTINCT FROM document_number),
        CHECK (source_snapshot#>>'{issuance,actorUserId}' IS NOT DISTINCT FROM issued_by_user_id::text),
        CHECK ((source_snapshot#>>'{issuance,issuedAt}')::timestamptz IS NOT DISTINCT FROM issued_at),
        CHECK (source_snapshot#>>'{issuer,profileId}' IS NOT DISTINCT FROM issuer_profile_id::text),
        CHECK (source_snapshot#>>'{bank,versionRowId}' IS NOT DISTINCT FROM bank_version_id::text),
        CHECK (source_snapshot#>>'{settings,settingsId}' IS NOT DISTINCT FROM settings_id::text),
        CHECK (jsonb_typeof(source_snapshot->'lines')='array' AND jsonb_array_length(source_snapshot->'lines')>0)
      );
      CREATE INDEX hm_quotation_document_request_idx ON handyman_quotation_documents(client_id,request_id,quotation_version_id);

      -- A document can only be inserted in the very transaction that issued this
      -- version. Historical ISSUED rows cannot be backfilled as if original.
      CREATE FUNCTION hm_quotation_document_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_quotation_versions v
          JOIN handyman_quotations q ON q.id=v.quotation_id
          JOIN handyman_service_requests r ON r.id=q.handyman_request_id AND r.client_id=q.client_id
          JOIN handyman_document_issuer_profiles i ON i.id=NEW.issuer_profile_id AND i.client_id=q.client_id AND i.status='ACTIVE'
          JOIN handyman_document_issuer_bank_accounts b ON b.id=NEW.bank_version_id AND b.client_id=q.client_id
            AND b.status='ACTIVE' AND b.is_default AND b.verified_at IS NOT NULL AND b.verified_by_user_id IS NOT NULL
          JOIN handyman_document_issuer_document_settings s ON s.id=NEW.settings_id AND s.client_id=q.client_id
            AND s.status='ACTIVE' AND s.document_kind='QUOTATION'
          WHERE v.id=NEW.quotation_version_id AND v.quotation_id=NEW.quotation_id
            AND q.client_id=NEW.client_id AND r.id=NEW.request_id AND v.status='ISSUED'
            AND v.xmin=(pg_current_xact_id()::text)::xid
            AND v.version_number=(NEW.source_snapshot#>>'{quotation,versionNumber}')::integer
            AND v.valid_until=(NEW.source_snapshot#>>'{quotation,validUntil}')::timestamptz
            AND v.dp_required=(NEW.source_snapshot#>>'{quotation,dpRequired}')::boolean
            AND v.dp_percentage IS NOT DISTINCT FROM (NEW.source_snapshot#>>'{quotation,dpPercentage}')::numeric
            AND v.dp_amount IS NOT DISTINCT FROM (NEW.source_snapshot#>>'{quotation,dpAmount}')::numeric
            AND v.dp_terms_notes IS NOT DISTINCT FROM NEW.source_snapshot#>>'{quotation,dpTermsNotes}'
            AND i.version=(NEW.source_snapshot#>>'{issuer,version}')::integer
            AND b.version=(NEW.source_snapshot#>>'{bank,version}')::integer
            AND b.currency=NEW.source_snapshot#>>'{quotation,currency}'
            AND b.account_number=NEW.source_snapshot#>>'{bank,accountNumber}'
            AND s.version=(NEW.source_snapshot#>>'{settings,version}')::integer
            AND s.document_prefix=NEW.source_snapshot#>>'{settings,documentPrefix}'
            AND s.language=NEW.source_snapshot#>>'{settings,language}'
            AND NEW.document_number LIKE s.document_prefix || '-%'
        ) THEN RAISE EXCEPTION 'Quotation document must be bound to the new ISSUE and active verified source records.' USING ERRCODE='23514'; END IF;
        IF (SELECT count(*) FROM handyman_quotation_lines WHERE quotation_version_id=NEW.quotation_version_id)
             <> jsonb_array_length(NEW.source_snapshot->'lines') THEN
          RAISE EXCEPTION 'Quotation document must contain every source line.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quotation_document_insert_guard BEFORE INSERT ON handyman_quotation_documents
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_document_insert_guard();

      -- New versions must enter through the existing DRAFT lifecycle; direct
      -- INSERT as ISSUED cannot bypass the deferred artifact requirement.
      CREATE FUNCTION hm_quotation_version_insert_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status <> 'DRAFT' THEN
          RAISE EXCEPTION 'New quotation versions must begin as DRAFT.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quotation_version_insert_draft_only BEFORE INSERT ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_version_insert_draft_only();

      -- Existing historical versions are deliberately not checked or modified.
      CREATE FUNCTION hm_quotation_issue_requires_document() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_quotation_documents d
          WHERE d.quotation_version_id=NEW.id AND d.quotation_id=NEW.quotation_id) THEN
          RAISE EXCEPTION 'A new ISSUED quotation requires its official immutable document in the same transaction.' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_quotation_issue_requires_document
        AFTER UPDATE ON handyman_quotation_versions DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (OLD.status='DRAFT' AND NEW.status='ISSUED')
        EXECUTE FUNCTION hm_quotation_issue_requires_document();
      CREATE FUNCTION hm_quotation_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_quotation_documents) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Issued quotation documents are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_quotation_document_no_write BEFORE UPDATE OR DELETE ON handyman_quotation_documents
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_document_immutable();
      CREATE TRIGGER hm_quotation_document_no_truncate BEFORE TRUNCATE ON handyman_quotation_documents
        FOR EACH STATEMENT EXECUTE FUNCTION hm_quotation_document_immutable();
      CREATE FUNCTION hm_quotation_document_validity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_quotation_documents d WHERE d.quotation_version_id=OLD.id) THEN
          IF NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
            RAISE EXCEPTION 'Issued quotation validity is pinned by its document.' USING ERRCODE='23514';
          END IF;
          IF NEW.status='DRAFT' AND OLD.status<>'DRAFT' THEN
            RAISE EXCEPTION 'An issued quotation document cannot return to DRAFT.' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quotation_document_validity_no_write BEFORE UPDATE ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_document_validity_immutable();
      CREATE FUNCTION hm_quotation_document_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_quotation_documents WHERE quotation_version_id=NEW.quotation_version_id) THEN
          RAISE EXCEPTION 'Issued quotation document lines are immutable.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quotation_document_line_guard BEFORE INSERT ON handyman_quotation_lines
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_document_line_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_quotation_documents IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_quotation_documents) THEN
        RAISE EXCEPTION 'Refusing to remove issued quotation documents.'; END IF; END $$;
      DROP TRIGGER hm_quotation_document_line_guard ON handyman_quotation_lines;
      DROP FUNCTION hm_quotation_document_line_guard();
      DROP TRIGGER hm_quotation_document_validity_no_write ON handyman_quotation_versions;
      DROP FUNCTION hm_quotation_document_validity_immutable();
      DROP TRIGGER hm_quotation_issue_requires_document ON handyman_quotation_versions;
      DROP FUNCTION hm_quotation_issue_requires_document();
      DROP TRIGGER hm_quotation_version_insert_draft_only ON handyman_quotation_versions;
      DROP FUNCTION hm_quotation_version_insert_draft_only();
      DROP TABLE handyman_quotation_documents;
      DROP FUNCTION hm_quotation_document_insert_guard();
      DROP FUNCTION hm_quotation_document_immutable();
      DROP SEQUENCE handyman_quotation_document_number_seq;
    `);
  },
};
