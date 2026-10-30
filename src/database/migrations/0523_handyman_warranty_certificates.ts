import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A prospective, separately issued immutable artifact; no lifecycle mutation. */
export const migration0523HandymanWarrantyCertificates: Migration = {
  id: '0523_handyman_warranty_certificates',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_warranty_certificate_number_seq AS BIGINT;
      CREATE TABLE handyman_warranty_certificates (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        warranty_id UUID NOT NULL UNIQUE REFERENCES handyman_service_warranties(id),
        bast_id UUID NOT NULL REFERENCES handyman_bast_documents(id),
        bast_official_id UUID NOT NULL REFERENCES handyman_bast_official_documents(id),
        completion_verification_id UUID NOT NULL REFERENCES handyman_completion_verifications(id),
        manifest_id UUID NOT NULL REFERENCES handyman_completion_manifests(id),
        manifest_version INTEGER NOT NULL CHECK (manifest_version>0),
        manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
        issuer_profile_id UUID NOT NULL REFERENCES handyman_document_issuer_profiles(id),
        settings_id UUID NOT NULL REFERENCES handyman_document_issuer_document_settings(id),
        document_number TEXT NOT NULL UNIQUE CHECK (document_number ~ '^[A-Z][A-Z0-9-]*-[0-9]+$'),
        issued_by_user_id UUID NOT NULL REFERENCES users(id),
        issued_at TIMESTAMPTZ NOT NULL,
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
        source_canonical TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        pdf_filename TEXT NOT NULL CHECK (pdf_filename ~ '^warranty-[a-z0-9-]+[.]pdf$'),
        pdf_bytes BYTEA NOT NULL,
        pdf_size INTEGER NOT NULL CHECK (pdf_size BETWEEN 1 AND 10485760 AND pdf_size=octet_length(pdf_bytes)),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        UNIQUE (execution_scope_id,idempotency_key),
        CHECK (source_canonical::jsonb=source_snapshot),
        CHECK (source_sha256=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
        CHECK (pdf_sha256=encode(sha256(pdf_bytes),'hex')),
        CHECK (substring(pdf_bytes FROM 1 FOR 5)=decode('255044462d','hex'))
      );
      CREATE INDEX hm_warranty_cert_request_idx ON handyman_warranty_certificates(client_id,request_id);
      CREATE FUNCTION hm_warranty_certificate_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item JSONB; a JSONB; previous JSONB; agreed JSONB; previous_terms JSONB;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_service_warranties w
          JOIN handyman_execution_scopes s ON s.id=w.execution_scope_id AND s.client_id=w.client_id
          JOIN handyman_service_requests r ON r.id=s.handyman_request_id AND r.client_id=s.client_id
            AND r.building_id=s.building_id AND r.tenant_company_id=s.tenant_company_id
          JOIN handyman_bast_documents b ON b.id=w.bast_id AND b.client_id=s.client_id AND b.execution_scope_id=s.id
            AND b.status='ACCEPTED' AND b.accepted_at IS NOT NULL AND w.starts_at=b.accepted_at AND w.bast_accepted_at=b.accepted_at
          JOIN handyman_bast_official_documents bd ON bd.id=NEW.bast_official_id AND bd.bast_id=b.id
            AND bd.client_id=s.client_id AND bd.building_id=s.building_id AND bd.request_id=r.id
            AND bd.execution_scope_id=s.id AND bd.tenant_company_id=s.tenant_company_id
          JOIN handyman_completion_verifications v ON v.id=b.completion_verification_id AND v.id=bd.completion_verification_id
            AND v.execution_scope_id=s.id
          JOIN handyman_completion_manifests m ON m.id=v.manifest_id AND m.execution_scope_id=s.id
            AND m.version=v.manifest_version AND m.source_sha256=v.manifest_sha256
          JOIN handyman_document_issuer_profiles i ON i.id=NEW.issuer_profile_id AND i.client_id=s.client_id AND i.status='ACTIVE'
          JOIN handyman_document_issuer_document_settings d ON d.id=NEW.settings_id AND d.client_id=s.client_id
            AND d.status='ACTIVE' AND d.document_kind='WARRANTY_CERTIFICATE'
          WHERE w.id=NEW.warranty_id AND w.bast_id=NEW.bast_id AND NEW.client_id=s.client_id AND NEW.building_id=s.building_id
            AND NEW.request_id=r.id AND NEW.tenant_company_id=s.tenant_company_id AND NEW.execution_scope_id=s.id
            AND NEW.completion_verification_id=v.id AND NEW.manifest_id=m.id AND NEW.manifest_version=m.version
            AND NEW.manifest_sha256=m.source_sha256 AND NOT EXISTS (SELECT 1 FROM handyman_completion_manifests newer
              WHERE newer.execution_scope_id=s.id AND newer.version>m.version)
            AND NEW.source_snapshot->>'schema'='HANDYMAN_WARRANTY_CERTIFICATE_V1' AND NEW.source_snapshot->>'status'='ISSUED'
            AND NEW.source_snapshot#>>'{issuance,id}'=NEW.id::text AND NEW.source_snapshot#>>'{issuance,number}'=NEW.document_number
            AND NEW.source_snapshot#>>'{issuance,actorUserId}'=NEW.issued_by_user_id::text
            AND (NEW.source_snapshot#>>'{issuance,issuedAt}')::timestamptz=NEW.issued_at
            AND NEW.source_snapshot#>>'{context,clientId}'=s.client_id::text AND NEW.source_snapshot#>>'{context,buildingId}'=s.building_id::text
            AND NEW.source_snapshot#>>'{context,requestId}'=r.id::text AND NEW.source_snapshot#>>'{context,tenantCompanyId}'=s.tenant_company_id::text
            AND NEW.source_snapshot#>>'{context,executionScopeId}'=s.id::text AND NEW.source_snapshot#>>'{warranty,id}'=w.id::text
            AND NEW.source_snapshot#>>'{bast,id}'=b.id::text AND (NEW.source_snapshot#>>'{bast,acceptedAt}')::timestamptz=b.accepted_at
            AND NEW.source_snapshot#>>'{bast,documentId}'=bd.id::text AND NEW.source_snapshot#>>'{bast,sourceSha256}'=bd.source_sha256
            AND NEW.source_snapshot#>>'{bast,pdfSha256}'=bd.pdf_sha256 AND NEW.source_snapshot#>'{bast,snapshot}'=bd.source_snapshot
            AND NEW.source_snapshot#>>'{manifest,id}'=m.id::text
            AND (NEW.source_snapshot#>>'{manifest,version}')::integer=m.version AND NEW.source_snapshot#>>'{manifest,sha256}'=m.source_sha256
            AND NEW.source_snapshot#>'{manifest,snapshot}'=m.source_snapshot
            AND NEW.source_snapshot#>>'{issuer,profileId}'=i.id::text AND NEW.source_snapshot#>>'{settings,settingsId}'=d.id::text
            AND NEW.document_number LIKE d.document_prefix || '-%'
            AND NEW.source_snapshot#>>'{context,buildingName}'=bd.source_snapshot#>>'{customer,buildingName}'
            AND NEW.source_snapshot#>>'{context,tenantName}'=bd.source_snapshot#>>'{customer,tenantName}'
            AND NEW.source_snapshot#>>'{context,tenantLegalName}' IS NOT DISTINCT FROM bd.source_snapshot#>>'{customer,legalName}'
            AND NEW.source_snapshot#>>'{context,spaceId}' IS NOT DISTINCT FROM bd.source_snapshot#>>'{customer,spaceId}'
            AND NEW.source_snapshot->'approvedQuotation'=bd.source_snapshot->'approvedQuotation'
            AND NEW.source_snapshot#>>'{context,clientName}'=(SELECT name FROM clients WHERE id=s.client_id)
            AND EXISTS (SELECT 1 FROM handyman_service_warranty_events e WHERE e.warranty_id=w.id
              AND e.execution_scope_id=s.id AND e.bast_id=b.id AND e.event_type='START')
        ) THEN RAISE EXCEPTION 'Warranty certificate requires the exact accepted BAST, lifecycle warranty and verified completion.' USING ERRCODE='23514'; END IF;
        IF jsonb_typeof(NEW.source_snapshot->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.source_snapshot->'items')=0 OR
          (SELECT count(DISTINCT elem->>'rootLineId') FROM jsonb_array_elements(NEW.source_snapshot->'items') elem)
            <> jsonb_array_length(NEW.source_snapshot->'items') OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'items') elem WHERE
            COALESCE(elem#>>'{terms,coverage}','') NOT IN ('LABOR','PARTS','BOTH') OR
            elem#>>'{terms,commencementRule}' IS DISTINCT FROM 'BAST_ACCEPTED_AT' OR
            (elem->>'startsAt')::timestamptz IS DISTINCT FROM (NEW.source_snapshot#>>'{bast,acceptedAt}')::timestamptz OR
            NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot#>'{manifest,snapshot,items}') m
              WHERE m->>'quotationLineId'=elem->>'rootLineId' AND m->>'quotationVersionId'=elem->>'quotationVersionId'
                AND m->>'variationId' IS NOT DISTINCT FROM elem->>'variationId' AND m->>'description'=elem->>'description'
                AND m->>'lineType'=elem->>'lineType' AND m->>'actualQty'=elem->>'actualQty'
                AND m->>'status' IN ('COMPLETED','PARTIAL') AND (m->>'actualQty')::numeric>0) OR
            (elem->>'endsAtExclusive')::timestamptz IS DISTINCT FROM CASE elem#>>'{terms,endRule}'
              WHEN 'DURATION_DAYS' THEN (NEW.source_snapshot#>>'{bast,acceptedAt}')::timestamptz + (elem#>>'{terms,durationDays}')::integer * interval '24 hours'
              WHEN 'FIXED_END_DATE_JAKARTA' THEN ((elem#>>'{terms,fixedEndDate}')::date+1)::timestamp AT TIME ZONE 'Asia/Jakarta'
              ELSE NULL END OR
            (elem->>'endsAtExclusive')::timestamptz <= (NEW.source_snapshot#>>'{bast,acceptedAt}')::timestamptz OR
            NOT EXISTS (SELECT 1 FROM handyman_bast_official_documents bd CROSS JOIN LATERAL
              jsonb_array_elements(bd.source_snapshot->'units') u WHERE bd.id=NEW.bast_official_id
                AND u->>'symbol'=elem->>'unit' AND u->>'id'=(SELECT m->>'uomId' FROM
                  jsonb_array_elements(NEW.source_snapshot#>'{manifest,snapshot,items}') m WHERE m->>'quotationLineId'=elem->>'rootLineId'))
        ) THEN RAISE EXCEPTION 'Certificate may contain only exact completed items with valid contractual periods.' USING ERRCODE='23514'; END IF;
        -- Independently enforce the exact customer-approved source chain even
        -- for direct INSERTs; checksums alone do not establish consent.
        FOR item IN SELECT value FROM jsonb_array_elements(NEW.source_snapshot->'items') LOOP
          previous := NULL; previous_terms := NULL;
          IF jsonb_typeof(item->'agreementChain') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'agreementChain')=0 THEN
            RAISE EXCEPTION 'Certificate item has no agreement chain.' USING ERRCODE='23514';
          END IF;
          FOR a IN SELECT value FROM jsonb_array_elements(item->'agreementChain') LOOP
            agreed := NULL;
            IF previous IS NULL AND a->>'kind'='QUOTATION' AND item->>'variationId' IS NULL THEN
              SELECT line->'warrantyTerms' INTO agreed FROM handyman_execution_scopes s
              JOIN handyman_quotation_decisions q ON q.id=s.quotation_decision_id AND q.decision='APPROVE'
                AND q.quotation_version_id=s.approved_quotation_version_id AND q.tenant_company_id=s.tenant_company_id
              JOIN handyman_quotation_documents d ON d.id=q.offer_document_id AND d.quotation_version_id=q.quotation_version_id
                AND d.source_sha256=q.offer_source_sha256 AND d.pdf_sha256=q.offer_pdf_sha256
              CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'lines') line
              WHERE s.id=NEW.execution_scope_id AND d.client_id=NEW.client_id AND d.request_id=NEW.request_id
                AND d.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_QUOTATION_LINE_WARRANTY_V1'
                AND d.source_sha256=encode(sha256(convert_to(d.source_canonical,'UTF8')),'hex')
                AND d.pdf_sha256=encode(sha256(d.pdf_bytes),'hex') AND d.source_canonical::jsonb=d.source_snapshot
                AND line->>'id'=item->>'rootLineId' AND line->>'id'=a->>'lineId'
                AND d.quotation_version_id::text=item->>'quotationVersionId'
                AND q.id::text=a->>'decisionId' AND d.id::text=a->>'documentId'
                AND d.document_number=a->>'number' AND d.source_sha256=a->>'sourceSha256' AND d.pdf_sha256=a->>'pdfSha256'
                AND d.source_snapshot#>>'{quotation,versionNumber}'=a->>'version'
                AND NEW.source_snapshot#>'{quotation,snapshot}'=d.source_snapshot
                AND NEW.source_snapshot#>>'{quotation,documentId}'=d.id::text;
            ELSIF (previous IS NULL AND a->>'kind'='ADD' AND a->>'variationId'=item->>'variationId'
                AND a->>'lineId'=item->>'rootLineId') OR (previous IS NOT NULL AND a->>'kind'='AMEND') THEN
              SELECT c->'warrantyTerms' INTO agreed FROM handyman_scope_variations v
              JOIN handyman_variation_offer_documents d ON d.variation_id=v.id AND d.execution_scope_id=v.execution_scope_id
              JOIN handyman_scope_variation_events e ON e.variation_id=v.id AND e.id::text=a->>'decisionId'
                AND e.event_type='TENANT_DECISION' AND e.actor_role='TENANT' AND e.actor_user_id=v.tenant_decided_by_user_id
                AND e.metadata->>'decisionOutcome'='APPROVED' AND e.metadata#>>'{consentSnapshot,offerDocumentId}'=d.id::text
                AND e.metadata#>>'{consentSnapshot,offerDocumentVersion}'=d.variation_version::text
                AND e.metadata#>>'{consentSnapshot,offerPdfSha256}'=d.pdf_sha256
              JOIN handyman_scope_variation_events r ON r.variation_id=v.id AND r.event_type='REVISED_QUOTATION'
                AND r.actor_role='OPERATIONS_MANAGER' AND r.metadata#>>'{offerDocument,id}'=d.id::text
                AND r.metadata#>>'{offerDocument,sourceSha256}'=d.source_sha256 AND r.metadata#>>'{offerDocument,pdfSha256}'=d.pdf_sha256
              CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'warrantyChanges') c
              WHERE v.id::text=a->>'variationId' AND v.execution_scope_id=NEW.execution_scope_id AND v.client_id=NEW.client_id
                AND v.tenant_decision_outcome='APPROVED' AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
                AND d.id::text=a->>'documentId' AND d.document_number=a->>'number' AND d.variation_version::text=a->>'version'
                AND d.source_sha256=a->>'sourceSha256' AND d.pdf_sha256=a->>'pdfSha256'
                AND d.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_VARIATION_LINE_WARRANTY_V1'
                AND d.source_sha256=encode(sha256(convert_to(d.source_canonical,'UTF8')),'hex')
                AND d.pdf_sha256=encode(sha256(d.pdf_bytes),'hex') AND d.source_canonical::jsonb=d.source_snapshot
                AND c->>'kind'=a->>'kind' AND c->>'quotationLineId'=a->>'lineId'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'variations') frozen
                  WHERE frozen->>'documentId'=d.id::text AND frozen->'snapshot'=d.source_snapshot)
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot#>'{manifest,snapshot,approvedVariations}') pin
                  JOIN handyman_scope_variation_events auth ON auth.id::text=pin->>'authorizationEventId'
                    AND auth.variation_id=v.id AND auth.event_type='AUTHORIZED_SCOPE' AND auth.actor_role='OPERATIONS_MANAGER'
                  WHERE pin->>'id'=v.id::text AND pin->>'decisionEventId'=e.id::text AND pin->>'approvedVersion'=d.variation_version::text)
                AND ((previous IS NULL AND c->>'kind'='ADD' AND d.revised_quotation_version_id::text=item->>'quotationVersionId'
                    AND d.source_snapshot#>>'{variation,revisedQuotationLineId}'=item->>'rootLineId') OR
                  (previous IS NOT NULL AND EXISTS (SELECT 1 FROM handyman_warranty_term_supersessions edge
                    WHERE edge.execution_scope_id=NEW.execution_scope_id AND edge.predecessor_line_id::text=previous->>'lineId'
                      AND edge.successor_line_id::text=a->>'lineId' AND edge.variation_id=v.id AND edge.offer_document_id=d.id
                      AND edge.tenant_decision_event_id=e.id AND c->>'replacesQuotationLineId'=previous->>'lineId')
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.source_snapshot->'warrantyPredecessors') predecessor
                      WHERE predecessor->>'quotationLineId'=previous->>'lineId' AND predecessor->>'documentId'=previous->>'documentId'
                        AND predecessor->>'decisionId'=previous->>'decisionId' AND predecessor->>'sourceSha256'=previous->>'sourceSha256'
                        AND predecessor->>'pdfSha256'=previous->>'pdfSha256' AND predecessor->'warrantyTerms'=previous_terms)));
            END IF;
            IF agreed IS NULL THEN RAISE EXCEPTION 'Certificate item is not backed by exact approved terms.' USING ERRCODE='23514'; END IF;
            previous := a; previous_terms := agreed;
          END LOOP;
          IF previous_terms IS DISTINCT FROM item->'terms' OR EXISTS (SELECT 1 FROM handyman_warranty_term_supersessions edge
            WHERE edge.execution_scope_id=NEW.execution_scope_id AND edge.predecessor_line_id::text=previous->>'lineId') THEN
            RAISE EXCEPTION 'Certificate item terms are stale or differ from the agreed successor.' USING ERRCODE='23514';
          END IF;
        END LOOP;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_certificate_insert_guard BEFORE INSERT ON handyman_warranty_certificates
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_certificate_insert_guard();
      CREATE FUNCTION hm_warranty_certificate_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_warranty_certificates) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Issued warranty certificates are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_warranty_certificate_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_certificates
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_certificate_immutable();
      CREATE TRIGGER hm_warranty_certificate_no_truncate BEFORE TRUNCATE ON handyman_warranty_certificates
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_certificate_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`LOCK TABLE handyman_warranty_certificates IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_warranty_certificates) THEN
        RAISE EXCEPTION 'Cannot discard issued warranty certificates.'; END IF; END $$;
      DROP TABLE handyman_warranty_certificates;
      DROP FUNCTION hm_warranty_certificate_insert_guard();
      DROP FUNCTION hm_warranty_certificate_immutable();
      DROP SEQUENCE handyman_warranty_certificate_number_seq;`);
  },
};
