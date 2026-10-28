import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Prospective only: no historical offer, decision, warranty or expiry is backfilled. */
export const migration0522HandymanAgreedWarrantyTerms: Migration = {
  id: '0522_handyman_agreed_warranty_terms',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_quotation_line_warranty_terms (
        quotation_line_id UUID PRIMARY KEY REFERENCES handyman_quotation_lines(id),
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        coverage TEXT NOT NULL CHECK (coverage IN ('NONE','LABOR','PARTS','BOTH')),
        covered_services TEXT,
        covered_materials TEXT,
        conditions TEXT,
        exclusions TEXT,
        commencement_rule TEXT,
        end_rule TEXT,
        duration_days INTEGER,
        fixed_end_date DATE,
        replaces_quotation_line_id UUID REFERENCES handyman_quotation_lines(id),
        authored_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK ((
          (coverage='NONE' AND covered_services IS NULL AND covered_materials IS NULL AND conditions IS NULL AND exclusions IS NULL
            AND commencement_rule IS NULL AND end_rule IS NULL AND duration_days IS NULL AND fixed_end_date IS NULL)
          OR
          (coverage IN ('LABOR','PARTS','BOTH')
            AND ((coverage IN ('LABOR','BOTH') AND length(btrim(covered_services)) BETWEEN 1 AND 800)
              OR (coverage='PARTS' AND covered_services IS NULL))
            AND ((coverage IN ('PARTS','BOTH') AND length(btrim(covered_materials)) BETWEEN 1 AND 800)
              OR (coverage='LABOR' AND covered_materials IS NULL))
            AND length(btrim(conditions)) BETWEEN 1 AND 1000 AND length(btrim(exclusions)) BETWEEN 1 AND 1000
            AND commencement_rule='BAST_ACCEPTED_AT'
            AND ((end_rule='DURATION_DAYS' AND duration_days BETWEEN 1 AND 36500 AND fixed_end_date IS NULL)
              OR (end_rule='FIXED_END_DATE_JAKARTA' AND duration_days IS NULL AND fixed_end_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')))
        ) IS TRUE)
      );
      CREATE INDEX hm_quote_warranty_version_idx ON handyman_quotation_line_warranty_terms(quotation_version_id);
      CREATE UNIQUE INDEX hm_quote_warranty_replaces_once_idx
        ON handyman_quotation_line_warranty_terms(quotation_version_id,replaces_quotation_line_id)
        WHERE replaces_quotation_line_id IS NOT NULL;

      CREATE FUNCTION hm_quote_warranty_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE line_id UUID; version_id UUID; state TEXT; quote_id UUID; version_no INTEGER; kind TEXT;
      BEGIN
        line_id := CASE WHEN TG_OP='DELETE' THEN OLD.quotation_line_id ELSE NEW.quotation_line_id END;
        version_id := CASE WHEN TG_OP='DELETE' THEN OLD.quotation_version_id ELSE NEW.quotation_version_id END;
        IF TG_OP='UPDATE' AND (NEW.quotation_line_id IS DISTINCT FROM OLD.quotation_line_id OR
          NEW.quotation_version_id IS DISTINCT FROM OLD.quotation_version_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
          RAISE EXCEPTION 'Warranty term identity is immutable.' USING ERRCODE='23514';
        END IF;
        SELECT v.status,v.quotation_id,v.version_number,l.line_type INTO state,quote_id,version_no,kind
          FROM handyman_quotation_versions v JOIN handyman_quotation_lines l ON l.quotation_version_id=v.id
          WHERE v.id=version_id AND l.id=line_id FOR UPDATE OF v;
        IF state IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION 'Warranty terms may only be authored for an exact DRAFT quotation line.' USING ERRCODE='23514';
        END IF;
        IF TG_OP<>'DELETE' AND NEW.replaces_quotation_line_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM handyman_quotation_lines p JOIN handyman_quotation_versions pv ON pv.id=p.quotation_version_id
          JOIN handyman_quotation_line_warranty_terms pt ON pt.quotation_line_id=p.id AND pt.quotation_version_id=pv.id
          JOIN handyman_quotation_documents pd ON pd.quotation_version_id=pv.id
          WHERE p.id=NEW.replaces_quotation_line_id AND pv.quotation_id=quote_id AND pv.version_number<version_no
            AND pv.status<>'DRAFT' AND p.line_type=kind
            AND pd.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_QUOTATION_LINE_WARRANTY_V1'
        ) THEN
          RAISE EXCEPTION 'Warranty predecessor must be an earlier issued line of the same quotation and type with disclosed terms.' USING ERRCODE='23514';
        END IF;
        -- A row-version fence prevents an ISSUE transaction at REPEATABLE READ
        -- from freezing a stale draft after waiting for a concurrent author.
        UPDATE handyman_quotation_versions SET updated_at=clock_timestamp() WHERE id=version_id;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_warranty_draft_only BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_quotation_line_warranty_terms FOR EACH ROW EXECUTE FUNCTION hm_quote_warranty_draft_only();
      CREATE FUNCTION hm_quote_warranty_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_quotation_line_warranty_terms) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Quotation warranty terms cannot be truncated.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_quote_warranty_no_truncate BEFORE TRUNCATE ON handyman_quotation_line_warranty_terms
        FOR EACH STATEMENT EXECUTE FUNCTION hm_quote_warranty_no_truncate();

      CREATE FUNCTION hm_quote_issue_warranty_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status='DRAFT' AND NEW.status='ISSUED' AND EXISTS (
          SELECT 1 FROM handyman_quotation_lines l LEFT JOIN handyman_quotation_line_warranty_terms w
            ON w.quotation_line_id=l.id AND w.quotation_version_id=l.quotation_version_id
          WHERE l.quotation_version_id=NEW.id AND w.quotation_line_id IS NULL
        ) THEN RAISE EXCEPTION 'Every issued quotation line requires explicitly selected warranty terms.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_issue_warranty_required BEFORE UPDATE ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION hm_quote_issue_warranty_required();

      CREATE FUNCTION hm_quote_document_warranty_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_snapshot->>'warrantyTermsProtocol' IS DISTINCT FROM 'HANDYMAN_QUOTATION_LINE_WARRANTY_V1' OR
           jsonb_typeof(NEW.source_snapshot->'lines') IS DISTINCT FROM 'array' OR
           jsonb_array_length(NEW.source_snapshot->'lines')<>(SELECT count(*) FROM handyman_quotation_lines WHERE quotation_version_id=NEW.quotation_version_id) OR
           EXISTS (
          SELECT 1 FROM handyman_quotation_lines l LEFT JOIN handyman_quotation_line_warranty_terms w
            ON w.quotation_line_id=l.id AND w.quotation_version_id=l.quotation_version_id
          WHERE l.quotation_version_id=NEW.quotation_version_id AND (w.quotation_line_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'lines') x WHERE x->>'id'=l.id::text
              AND x->>'replacesQuotationLineId' IS NOT DISTINCT FROM w.replaces_quotation_line_id::text
              AND x->'warrantyTerms'=jsonb_build_object('coverage',w.coverage,'coveredServices',w.covered_services,'coveredMaterials',w.covered_materials,
                'conditions',w.conditions,'exclusions',w.exclusions,'commencementRule',w.commencement_rule,
                'endRule',w.end_rule,'durationDays',w.duration_days,'fixedEndDate',to_char(w.fixed_end_date,'YYYY-MM-DD'))
          ))
        ) THEN RAISE EXCEPTION 'Issued quotation source must freeze exact authored warranty terms for every item.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quote_document_warranty_guard BEFORE INSERT ON handyman_quotation_documents
        FOR EACH ROW EXECUTE FUNCTION hm_quote_document_warranty_guard();

      -- The list is the ONLY set of warranty changes proposed by a variation.
      -- The two quotation snapshots are separately protected by 0513.
      CREATE FUNCTION hm_variation_offer_warranty_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE proposed JSONB; expected JSONB;
      BEGIN
        IF NEW.source_snapshot->>'warrantyTermsProtocol' IS DISTINCT FROM 'HANDYMAN_VARIATION_LINE_WARRANTY_V1' OR
           NEW.source_snapshot#>>'{revised,warrantyTermsProtocol}' IS DISTINCT FROM 'HANDYMAN_QUOTATION_LINE_WARRANTY_V1' OR
           jsonb_typeof(NEW.source_snapshot->'warrantyChanges') IS DISTINCT FROM 'array' OR
           jsonb_typeof(NEW.source_snapshot->'warrantyPredecessors') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Variation offer requires explicit warranty change disclosure.' USING ERRCODE='23514';
        END IF;
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'kind',CASE WHEN x->>'id'=NEW.source_snapshot#>>'{variation,priceBasisLineId}' AND NEW.source_snapshot#>>'{variation,variationType}'='ADD'
            THEN 'ADD' ELSE 'AMEND' END,
          'quotationLineId',x->>'id','replacesQuotationLineId',x->'replacesQuotationLineId',
          'warrantyTerms',x->'warrantyTerms') ORDER BY x->>'id'),'[]'::jsonb) INTO expected
        FROM jsonb_array_elements(NEW.source_snapshot#>'{revised,lines}') x
        WHERE x->>'replacesQuotationLineId' IS NOT NULL OR
          (NEW.source_snapshot#>>'{variation,variationType}'='ADD' AND x->>'id'=NEW.source_snapshot#>>'{variation,priceBasisLineId}');
        proposed := NEW.source_snapshot->'warrantyChanges';
        IF proposed IS DISTINCT FROM expected OR EXISTS (SELECT 1 FROM jsonb_array_elements(proposed) x
          WHERE (x->>'kind'='ADD' AND x->>'replacesQuotationLineId' IS NOT NULL) OR
                (x->>'kind'='AMEND' AND x->>'replacesQuotationLineId' IS NULL)) THEN
          RAISE EXCEPTION 'Variation warranty changes must identify exact added or explicitly replaced lines.' USING ERRCODE='23514';
        END IF;
        IF jsonb_array_length(NEW.source_snapshot->'warrantyPredecessors') <>
           (SELECT count(*) FROM jsonb_array_elements(proposed) c WHERE c->>'kind'='AMEND') OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(proposed) c WHERE c->>'kind'='AMEND' AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.source_snapshot->'warrantyPredecessors') p
            WHERE p->>'quotationLineId'=c->>'replacesQuotationLineId' AND (
              EXISTS (SELECT 1 FROM handyman_execution_scopes s JOIN handyman_quotation_decisions q
                ON q.id=s.quotation_decision_id AND q.decision='APPROVE' AND q.quotation_version_id=s.approved_quotation_version_id
                JOIN handyman_quotation_documents d ON d.id=q.offer_document_id AND d.client_id=s.client_id
                  AND d.source_sha256=q.offer_source_sha256 AND d.pdf_sha256=q.offer_pdf_sha256
                CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'lines') l
                WHERE s.id=NEW.execution_scope_id AND p->>'authority'='QUOTATION' AND p->>'decisionId'=q.id::text
                  AND p->>'documentId'=d.id::text AND p->>'sourceSha256'=d.source_sha256 AND p->>'pdfSha256'=d.pdf_sha256
                  AND d.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_QUOTATION_LINE_WARRANTY_V1'
                  AND l->>'id'=p->>'quotationLineId' AND l->>'description'=p->>'description' AND l->'warrantyTerms'=p->'warrantyTerms')
              OR EXISTS (SELECT 1 FROM handyman_scope_variations v JOIN handyman_variation_offer_documents d
                ON d.variation_id=v.id AND d.execution_scope_id=v.execution_scope_id
                JOIN handyman_scope_variation_events e ON e.variation_id=v.id AND e.event_type='TENANT_DECISION'
                  AND e.actor_role='TENANT' AND e.actor_user_id=v.tenant_decided_by_user_id AND e.metadata->>'decisionOutcome'='APPROVED'
                  AND e.metadata#>>'{consentSnapshot,offerDocumentId}'=d.id::text
                  AND e.metadata#>>'{consentSnapshot,offerDocumentVersion}'=d.variation_version::text
                  AND e.metadata#>>'{consentSnapshot,offerPdfSha256}'=d.pdf_sha256
                CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot#>'{revised,lines}') l
                WHERE v.execution_scope_id=NEW.execution_scope_id AND v.id<>NEW.variation_id
                  AND v.tenant_decision_outcome='APPROVED' AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
                  AND p->>'authority'='VARIATION' AND p->>'decisionId'=e.id::text AND p->>'documentId'=d.id::text
                  AND p->>'sourceSha256'=d.source_sha256 AND p->>'pdfSha256'=d.pdf_sha256
                  AND d.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_VARIATION_LINE_WARRANTY_V1'
                  AND l->>'id'=p->>'quotationLineId' AND l->>'description'=p->>'description' AND l->'warrantyTerms'=p->'warrantyTerms'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.source_snapshot->'warrantyChanges') prev
                    WHERE prev->>'quotationLineId'=p->>'quotationLineId'))
            )
          )
        ) THEN RAISE EXCEPTION 'Warranty amendment requires the exact previously consented item and document lineage.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_variation_offer_warranty_guard BEFORE INSERT ON handyman_variation_offer_documents
        FOR EACH ROW EXECUTE FUNCTION hm_variation_offer_warranty_guard();

      -- Atomic, append-only arbitration of tenant-consented replacements. The
      -- unique parent fence rejects competing decisions even under stale MVCC
      -- snapshots; no old decision or lifecycle warranty is retrofilled.
      CREATE TABLE handyman_warranty_term_supersessions (
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        predecessor_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        successor_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        variation_id UUID NOT NULL REFERENCES handyman_scope_variations(id),
        offer_document_id UUID NOT NULL REFERENCES handyman_variation_offer_documents(id),
        tenant_decision_event_id UUID NOT NULL REFERENCES handyman_scope_variation_events(id),
        PRIMARY KEY (execution_scope_id,predecessor_line_id),
        UNIQUE (execution_scope_id,successor_line_id)
      );
      CREATE FUNCTION hm_warranty_supersession_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_scope_variation_events e
          JOIN handyman_variation_offer_documents d ON d.id=NEW.offer_document_id AND d.variation_id=e.variation_id
            AND d.execution_scope_id=e.execution_scope_id
          CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'warrantyChanges') c
          WHERE e.id=NEW.tenant_decision_event_id AND e.variation_id=NEW.variation_id AND e.execution_scope_id=NEW.execution_scope_id
            AND e.event_type='TENANT_DECISION' AND e.actor_role='TENANT' AND e.metadata->>'decisionOutcome'='APPROVED'
            AND e.xmin=(pg_current_xact_id()::text)::xid
            AND e.metadata#>>'{consentSnapshot,offerDocumentId}'=d.id::text
            AND e.metadata#>>'{consentSnapshot,offerDocumentVersion}'=d.variation_version::text
            AND e.metadata#>>'{consentSnapshot,offerPdfSha256}'=d.pdf_sha256
            AND d.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_VARIATION_LINE_WARRANTY_V1'
            AND c->>'kind'='AMEND' AND c->>'replacesQuotationLineId'=NEW.predecessor_line_id::text
            AND c->>'quotationLineId'=NEW.successor_line_id::text
        ) THEN RAISE EXCEPTION 'Warranty lineage must be created with the exact new Tenant approval.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_supersession_insert_guard BEFORE INSERT ON handyman_warranty_term_supersessions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_supersession_insert_guard();
      CREATE FUNCTION hm_warranty_supersession_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_warranty_term_supersessions) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Consented warranty lineage is immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_warranty_supersession_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_term_supersessions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_supersession_immutable();
      CREATE TRIGGER hm_warranty_supersession_no_truncate BEFORE TRUNCATE ON handyman_warranty_term_supersessions
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_supersession_immutable();
      CREATE FUNCTION hm_warranty_supersession_from_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type='TENANT_DECISION' AND NEW.metadata->>'decisionOutcome'='APPROVED' THEN
          INSERT INTO handyman_warranty_term_supersessions
            (execution_scope_id,predecessor_line_id,successor_line_id,variation_id,offer_document_id,tenant_decision_event_id)
          SELECT NEW.execution_scope_id,(c->>'replacesQuotationLineId')::uuid,(c->>'quotationLineId')::uuid,
            NEW.variation_id,d.id,NEW.id
          FROM handyman_variation_offer_documents d CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'warrantyChanges') c
          WHERE d.variation_id=NEW.variation_id AND d.execution_scope_id=NEW.execution_scope_id
            AND d.source_snapshot->>'warrantyTermsProtocol'='HANDYMAN_VARIATION_LINE_WARRANTY_V1'
            AND c->>'kind'='AMEND';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_supersession_from_decision AFTER INSERT ON handyman_scope_variation_events
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_supersession_from_decision();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_quotation_line_warranty_terms,handyman_warranty_term_supersessions IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_quotation_line_warranty_terms) OR EXISTS (SELECT 1 FROM handyman_warranty_term_supersessions) THEN
          RAISE EXCEPTION 'Refusing to remove authored or consented warranty history.';
        END IF;
      END $$;
      DROP TRIGGER IF EXISTS hm_warranty_supersession_from_decision ON handyman_scope_variation_events;
      DROP FUNCTION IF EXISTS hm_warranty_supersession_from_decision();
      DROP TABLE IF EXISTS handyman_warranty_term_supersessions;
      DROP FUNCTION IF EXISTS hm_warranty_supersession_immutable();
      DROP FUNCTION IF EXISTS hm_warranty_supersession_insert_guard();
      DROP TRIGGER IF EXISTS hm_variation_offer_warranty_guard ON handyman_variation_offer_documents;
      DROP FUNCTION IF EXISTS hm_variation_offer_warranty_guard();
      DROP TRIGGER IF EXISTS hm_quote_document_warranty_guard ON handyman_quotation_documents;
      DROP FUNCTION IF EXISTS hm_quote_document_warranty_guard();
      DROP TRIGGER IF EXISTS hm_quote_issue_warranty_required ON handyman_quotation_versions;
      DROP FUNCTION IF EXISTS hm_quote_issue_warranty_required();
      DROP TRIGGER IF EXISTS hm_quote_warranty_no_truncate ON handyman_quotation_line_warranty_terms;
      DROP FUNCTION IF EXISTS hm_quote_warranty_no_truncate();
      DROP TRIGGER IF EXISTS hm_quote_warranty_draft_only ON handyman_quotation_line_warranty_terms;
      DROP FUNCTION IF EXISTS hm_quote_warranty_draft_only();
      DROP TABLE IF EXISTS handyman_quotation_line_warranty_terms;
    `);
  },
};
