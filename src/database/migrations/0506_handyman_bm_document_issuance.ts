import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** The database is the durable, transactional artifact store; issued rows cannot be changed or removed. */
export const migration0506HandymanBmDocumentIssuance: Migration = {
  id: '0506_handyman_bm_document_issuance',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_bm_issued_documents (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        document_type TEXT NOT NULL CHECK (document_type IN ('COMMISSION_STATEMENT','MONTHLY_SERVICE_REPORT')),
        issuer_profile_id UUID NOT NULL REFERENCES handyman_document_issuer_profiles(id),
        counterparty_id UUID REFERENCES handyman_bm_legal_counterparties(id),
        agreement_version_id UUID REFERENCES handyman_commercial_agreement_versions(id),
        period_from DATE NOT NULL, period_to DATE NOT NULL CHECK (period_to >= period_from),
        issued_by UUID NOT NULL REFERENCES users(id), issued_at TIMESTAMPTZ NOT NULL,
        source_as_of TIMESTAMPTZ NOT NULL CHECK (issued_at >= source_as_of),
        idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key=btrim(idempotency_key)),
        request_intent JSONB NOT NULL CHECK (jsonb_typeof(request_intent)='object'), request_canonical TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
        source_canonical TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename TEXT NOT NULL CHECK (pdf_filename ~ '^[a-z0-9-]+[.]pdf$'),
        pdf_bytes BYTEA NOT NULL,
        pdf_size INTEGER NOT NULL CHECK (pdf_size BETWEEN 1 AND 10485760 AND pdf_size=octet_length(pdf_bytes)),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT hm_bm_document_idempotency_unique UNIQUE (client_id,building_id,idempotency_key),
        CHECK (request_canonical::jsonb=request_intent),
        CHECK (request_sha256=encode(sha256(convert_to(request_canonical,'UTF8')),'hex')),
        CHECK (source_canonical::jsonb=source_snapshot),
        CHECK (source_sha256=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
        CHECK (pdf_sha256=encode(sha256(pdf_bytes),'hex')),
        CHECK (substring(pdf_bytes FROM 1 FOR 5)=decode('255044462d','hex')),
        CHECK (source_snapshot->>'status' IS NOT DISTINCT FROM 'ISSUED'),
        CHECK (source_snapshot->>'clientId' IS NOT DISTINCT FROM client_id::text),
        CHECK (source_snapshot#>>'{building,id}' IS NOT DISTINCT FROM building_id::text),
        CHECK (source_snapshot#>>'{issuer,profileId}' IS NOT DISTINCT FROM issuer_profile_id::text),
        CHECK (source_snapshot#>>'{issuance,id}' IS NOT DISTINCT FROM id::text),
        CHECK (source_snapshot#>>'{issuance,issuedBy}' IS NOT DISTINCT FROM issued_by::text),
        CHECK ((source_snapshot->>'asOf')::timestamptz IS NOT DISTINCT FROM source_as_of),
        CHECK ((source_snapshot#>>'{issuance,issuedAt}')::timestamptz IS NOT DISTINCT FROM issued_at),
        CHECK ((document_type='COMMISSION_STATEMENT' AND counterparty_id IS NOT NULL AND agreement_version_id IS NOT NULL
                AND source_snapshot#>>'{beneficiary,id}' IS NOT DISTINCT FROM counterparty_id::text
                AND source_snapshot#>>'{agreement,versionId}' IS NOT DISTINCT FROM agreement_version_id::text
                AND (source_snapshot#>>'{period,dateFrom}')::date IS NOT DISTINCT FROM period_from
                AND (source_snapshot#>>'{period,dateTo}')::date IS NOT DISTINCT FROM period_to)
            OR (document_type='MONTHLY_SERVICE_REPORT' AND counterparty_id IS NULL AND agreement_version_id IS NULL
                AND ((source_snapshot#>>'{period,from}')::timestamptz AT TIME ZONE 'UTC') IS NOT DISTINCT FROM period_from::timestamp
                AND (source_snapshot#>>'{period,lastDay}')::date IS NOT DISTINCT FROM period_to
                AND jsonb_typeof(source_snapshot->'coverage')='array'
                AND jsonb_array_length(source_snapshot->'coverage')>0))
      );
      CREATE INDEX hm_bm_document_history_idx ON handyman_bm_issued_documents
        (client_id,building_id,document_type,issued_at DESC,id DESC);

      CREATE FUNCTION hm_bm_issued_document_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE pin JSONB;
      BEGIN
        IF NEW.source_as_of < ((NEW.period_to + 1)::timestamp AT TIME ZONE 'UTC') THEN
          RAISE EXCEPTION 'Issued document reporting period must be closed in UTC.' USING ERRCODE='23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM buildings b JOIN properties p ON p.id=b.property_id
          WHERE b.id=NEW.building_id AND p.client_id=NEW.client_id)
          OR NOT EXISTS (SELECT 1 FROM handyman_document_issuer_profiles i
            WHERE i.id=NEW.issuer_profile_id AND i.client_id=NEW.client_id AND i.status='ACTIVE'
              AND i.version=(NEW.source_snapshot#>>'{issuer,version}')::integer
              AND i.legal_name=NEW.source_snapshot#>>'{issuer,legalName}') THEN
          RAISE EXCEPTION 'Issued document Client, Building or issuer does not match.' USING ERRCODE='23514';
        END IF;
        IF jsonb_typeof(NEW.source_snapshot->'coverage') IS DISTINCT FROM 'array'
           OR jsonb_array_length(NEW.source_snapshot->'coverage')=0 THEN
          RAISE EXCEPTION 'Issued document requires verified BM coverage.' USING ERRCODE='23514';
        END IF;
        FOR pin IN SELECT value FROM jsonb_array_elements(NEW.source_snapshot->'coverage') LOOP
          IF NOT EXISTS (SELECT 1 FROM handyman_bm_building_coverages c
            JOIN handyman_bm_counterparty_verifications v ON v.id=c.verification_id AND v.counterparty_id=c.counterparty_id
            JOIN handyman_bm_legal_counterparties party ON party.id=c.counterparty_id AND party.client_id=c.client_id
            WHERE c.id::text=pin->>'id' AND c.client_id=NEW.client_id AND c.building_id=NEW.building_id
              AND c.verification_id::text=pin->>'verificationId' AND c.cancelled_at IS NULL
              AND c.effective_from=(pin->>'effectiveFrom')::timestamptz
              AND c.effective_to IS NOT DISTINCT FROM (pin->>'effectiveTo')::timestamptz
              AND ((NEW.document_type='MONTHLY_SERVICE_REPORT' AND c.counterparty_id::text=pin->>'counterpartyId'
                    AND c.agreement_version_id::text=pin->>'agreementVersionId' AND party.legal_name=pin->>'legalName'
                    AND c.effective_from < ((NEW.period_to + 1)::timestamp AT TIME ZONE 'UTC')
                    AND (c.effective_to IS NULL OR c.effective_to > (NEW.period_from::timestamp AT TIME ZONE 'UTC')))
                OR (NEW.document_type='COMMISSION_STATEMENT' AND c.counterparty_id=NEW.counterparty_id
                    AND c.agreement_version_id=NEW.agreement_version_id
                    AND party.legal_name=NEW.source_snapshot#>>'{beneficiary,legalName}'))) THEN
            RAISE EXCEPTION 'Issued document BM coverage pin does not match.' USING ERRCODE='23514';
          END IF;
        END LOOP;
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_bm_issued_document_insert BEFORE INSERT ON handyman_bm_issued_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bm_issued_document_insert_guard();
      CREATE FUNCTION hm_bm_issued_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Issued BM documents are immutable and cannot be removed.' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER hm_bm_issued_document_no_mutation BEFORE UPDATE OR DELETE ON handyman_bm_issued_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bm_issued_document_immutable();
      CREATE TRIGGER hm_bm_issued_document_no_truncate BEFORE TRUNCATE ON handyman_bm_issued_documents
        FOR EACH STATEMENT EXECUTE FUNCTION hm_bm_issued_document_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_bm_issued_documents) THEN
      RAISE EXCEPTION 'Refusing to remove issued BM documents and durable artifacts.'; END IF; END $$`);
    await tx.query(`DROP TABLE handyman_bm_issued_documents;
      DROP FUNCTION hm_bm_issued_document_insert_guard(); DROP FUNCTION hm_bm_issued_document_immutable();`);
  },
};
