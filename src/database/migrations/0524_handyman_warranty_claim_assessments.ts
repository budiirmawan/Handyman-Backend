import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Prospective claim authority; historical claim and certificate rows are not rewritten. */
export const migration0524HandymanWarrantyClaimAssessments: Migration = {
  id: '0524_handyman_warranty_claim_assessments',
  async up(tx: PoolClient): Promise<void> {
    // Deliberately granted to no role. An administrator must explicitly delegate it.
    await tx.query(`INSERT INTO permissions (id,code,name,status)
      VALUES ($1,'handyman.warranty.assess','Assess Handyman warranty claims','ACTIVE')
      ON CONFLICT (code) DO NOTHING`, [randomUUID()]);
    await tx.query(`
      CREATE TABLE handyman_warranty_claim_bindings (
        claim_id UUID PRIMARY KEY REFERENCES handyman_service_warranty_claims(id),
        certificate_id UUID NOT NULL REFERENCES handyman_warranty_certificates(id),
        certificate_number TEXT NOT NULL,
        certificate_source_sha256 TEXT NOT NULL CHECK (certificate_source_sha256 ~ '^[0-9a-f]{64}$'),
        certificate_pdf_sha256 TEXT NOT NULL CHECK (certificate_pdf_sha256 ~ '^[0-9a-f]{64}$'),
        certificate_manifest_version INTEGER NOT NULL CHECK (certificate_manifest_version>0),
        item_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        coverage_kind TEXT NOT NULL CHECK (coverage_kind IN ('LABOR','PARTS')),
        item_snapshot JSONB NOT NULL CHECK (jsonb_typeof(item_snapshot)='object'),
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at_exclusive TIMESTAMPTZ NOT NULL CHECK (ends_at_exclusive>starts_at),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_claim_in_period(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
        RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
        SELECT COALESCE($2 < $3 AND $1 >= $2 AND $1 < $3, false)
      $$;
      -- Re-prove the current accepted basis before new bindings, assessments,
      -- decisions or rework intake; never rewrite a historical certificate.
      CREATE FUNCTION hm_warranty_certificate_is_current(cert_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_warranty_certificates d
          JOIN handyman_completion_verifications v ON v.id=d.completion_verification_id AND v.execution_scope_id=d.execution_scope_id
          JOIN handyman_qc_runs q ON q.id=v.qc_run_id AND q.status='PASSED' AND q.version=v.qc_run_version
          JOIN handyman_qc_run_events qe ON qe.id=v.qc_finish_event_id AND qe.run_id=q.id
            AND qe.event_type='FINISH' AND qe.metadata->>'outcome'='PASSED'
          WHERE d.id=cert_uuid AND EXISTS (SELECT 1 FROM handyman_completion_manifests m WHERE m.id=d.manifest_id
            AND m.version=d.manifest_version AND m.source_sha256=d.manifest_sha256 AND m.execution_scope_id=d.execution_scope_id
            AND NOT EXISTS (SELECT 1 FROM handyman_completion_manifests newer
              WHERE newer.execution_scope_id=d.execution_scope_id AND newer.version>m.version))
          AND (SELECT COALESCE(jsonb_agg(s.id::text ORDER BY s.id::text),'[]'::jsonb) FROM handyman_work_sessions s
            WHERE s.execution_scope_id=d.execution_scope_id) =
            (SELECT COALESCE(jsonb_agg(x->>'id' ORDER BY x->>'id'),'[]'::jsonb)
              FROM jsonb_array_elements(d.source_snapshot#>'{manifest,snapshot,sessions}') x)
          AND (SELECT COALESCE(jsonb_agg(p.id ORDER BY p.id),'[]'::jsonb) FROM (
            SELECT cd.id::text AS id FROM handyman_completion_declarations cd
            LEFT JOIN handyman_completion_revocations cr ON cr.declaration_id=cd.id
            WHERE cd.execution_scope_id=d.execution_scope_id AND cr.id IS NULL
            UNION ALL SELECT al.id::text FROM handyman_add_labor_executions al WHERE al.execution_scope_id=d.execution_scope_id) p) =
            (SELECT COALESCE(jsonb_agg(e->>'id' ORDER BY e->>'id'),'[]'::jsonb)
              FROM jsonb_array_elements(d.source_snapshot#>'{manifest,snapshot,items}') i
              CROSS JOIN LATERAL jsonb_array_elements(i->'execution') e)
          AND (SELECT COALESCE(jsonb_agg(jsonb_build_object('predecessorLineId',e.predecessor_line_id,
            'successorLineId',e.successor_line_id,'variationId',e.variation_id,'offerDocumentId',e.offer_document_id,
            'tenantDecisionEventId',e.tenant_decision_event_id) ORDER BY e.predecessor_line_id),'[]'::jsonb)
            FROM handyman_warranty_term_supersessions e WHERE e.execution_scope_id=d.execution_scope_id) = d.source_snapshot->'edges'
          AND (SELECT COALESCE(jsonb_agg(sv.id::text ORDER BY sv.id::text),'[]'::jsonb)
            FROM handyman_scope_variations sv WHERE sv.execution_scope_id=d.execution_scope_id
              AND sv.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')) =
            (SELECT COALESCE(jsonb_agg(pin->>'id' ORDER BY pin->>'id'),'[]'::jsonb)
              FROM jsonb_array_elements(d.source_snapshot#>'{manifest,snapshot,approvedVariations}') pin))
      $$;
      CREATE FUNCTION hm_warranty_claim_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_warranty_claims c
          JOIN handyman_execution_scopes s ON s.id=c.execution_scope_id AND s.client_id=c.client_id
          JOIN handyman_warranty_certificates d ON d.id=NEW.certificate_id AND d.warranty_id=c.warranty_id
            AND d.client_id=c.client_id AND d.execution_scope_id=c.execution_scope_id AND d.bast_id=c.bast_id
            AND d.building_id=s.building_id AND d.tenant_company_id=s.tenant_company_id AND d.request_id=s.handyman_request_id
          CROSS JOIN LATERAL jsonb_array_elements(d.source_snapshot->'items') item
          WHERE c.id=NEW.claim_id AND c.status='CLAIM_DRAFT' AND c.opened_by_user_id=NEW.created_by_user_id
            AND d.source_snapshot->>'status'='ISSUED' AND d.source_snapshot->>'schema'='HANDYMAN_WARRANTY_CERTIFICATE_V1'
            AND hm_warranty_certificate_is_current(d.id)
            AND d.document_number=NEW.certificate_number AND d.source_sha256=NEW.certificate_source_sha256
            AND d.pdf_sha256=NEW.certificate_pdf_sha256 AND d.manifest_version=NEW.certificate_manifest_version
            AND d.source_sha256=encode(sha256(convert_to(d.source_canonical,'UTF8')),'hex')
            AND d.source_snapshot=d.source_canonical::jsonb AND d.pdf_sha256=encode(sha256(d.pdf_bytes),'hex')
            AND item->>'rootLineId'=NEW.item_line_id::text AND item=NEW.item_snapshot
            AND item#>>'{terms,coverage}' IN (NEW.coverage_kind,'BOTH')
            AND item#>>'{terms,commencementRule}'='BAST_ACCEPTED_AT'
            AND (item->>'startsAt')::timestamptz=NEW.starts_at
            AND (item->>'endsAtExclusive')::timestamptz=NEW.ends_at_exclusive
        ) THEN RAISE EXCEPTION 'Claim binding requires its exact issued certificate, completed covered item, terms and period.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_claim_binding_insert BEFORE INSERT ON handyman_warranty_claim_bindings
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_claim_binding_guard();
      CREATE FUNCTION hm_warranty_claim_binding_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_warranty_claim_bindings b WHERE b.claim_id=NEW.id) THEN
          RAISE EXCEPTION 'New warranty claims require an exact issued certificate and item binding.' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_warranty_claim_binding_required AFTER INSERT ON handyman_service_warranty_claims
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_warranty_claim_binding_required();

      CREATE TABLE handyman_warranty_claim_assessments (
        id UUID PRIMARY KEY,
        claim_id UUID NOT NULL REFERENCES handyman_warranty_claim_bindings(claim_id),
        revision INTEGER NOT NULL CHECK (revision>0),
        result TEXT NOT NULL CHECK (result IN ('COVERED','REJECTED','NEEDS_EVIDENCE')),
        reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
        conditions_disposition TEXT NOT NULL CHECK (conditions_disposition IN ('SATISFIED','NOT_SATISFIED','UNDETERMINED')),
        conditions_reason TEXT NOT NULL CHECK (length(btrim(conditions_reason)) BETWEEN 1 AND 2000),
        exclusions_disposition TEXT NOT NULL CHECK (exclusions_disposition IN ('NOT_APPLICABLE','APPLIES','UNDETERMINED')),
        exclusions_reason TEXT NOT NULL CHECK (length(btrim(exclusions_reason)) BETWEEN 1 AND 2000),
        claim_submitted_at TIMESTAMPTZ NOT NULL,
        claim_evidence JSONB NOT NULL CHECK (jsonb_typeof(claim_evidence)='object'),
        review_evidence JSONB NOT NULL CHECK (jsonb_typeof(review_evidence)='object'),
        reviewer_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        command_sha256 TEXT NOT NULL CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
        assessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (claim_id,revision), UNIQUE (claim_id,idempotency_key), UNIQUE (id,claim_id),
        CHECK (result<>'COVERED' OR (conditions_disposition='SATISFIED' AND exclusions_disposition='NOT_APPLICABLE'))
      );
      ALTER TABLE handyman_service_warranty_claims ADD COLUMN decision_assessment_id UUID;
      ALTER TABLE handyman_service_warranty_claims ADD CONSTRAINT hm_warranty_claim_decision_assessment_fk
        FOREIGN KEY (decision_assessment_id,id) REFERENCES handyman_warranty_claim_assessments(id,claim_id);

      -- The snapshot pins immutable file IDs/digests, rather than assuming that a
      -- record ID or a FINALIZE event alone establishes that bytes exist.
      CREATE FUNCTION hm_warranty_assessment_evidence_valid(snapshot JSONB, expected_client UUID,
        expected_scope UUID, require_verified BOOLEAN) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
      DECLARE f JSONB; record_id UUID; finish_id UUID;
      BEGIN
        IF jsonb_typeof(snapshot)<>'object' OR jsonb_typeof(snapshot->'files')<>'array' THEN RETURN false; END IF;
        BEGIN
          record_id := (snapshot->>'recordId')::uuid;
          finish_id := (snapshot->>'finalizeEventId')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
        IF record_id IS NULL OR NOT EXISTS (SELECT 1 FROM handyman_evidence_records e
          WHERE e.id=record_id AND e.client_id=expected_client AND e.execution_scope_id=expected_scope) THEN RETURN false; END IF;
        IF finish_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM handyman_evidence_record_events e
          WHERE e.id=finish_id AND e.record_id=record_id AND e.client_id=expected_client AND e.event_type='FINALIZE') THEN RETURN false; END IF;
        IF require_verified AND (finish_id IS NULL OR jsonb_array_length(snapshot->'files')=0
          OR snapshot->'byteVerified' IS DISTINCT FROM 'true'::jsonb) THEN RETURN false; END IF;
        FOR f IN SELECT value FROM jsonb_array_elements(snapshot->'files') LOOP
          IF NOT EXISTS (SELECT 1 FROM handyman_evidence_record_files ef WHERE ef.record_id=record_id
            AND ef.id::text=f->>'id' AND ef.media_kind=f->>'mediaKind' AND ef.content_type=f->>'contentType'
            AND ef.byte_size::text=f->>'byteSize' AND ef.sha256_digest=f->>'sha256Digest'
            AND ef.sha256_digest ~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
        END LOOP;
        RETURN true;
      END; $$;
      CREATE FUNCTION hm_warranty_claim_assessor_authorized(claim_uuid UUID, actor_uuid UUID)
        RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_service_warranty_claims c
          JOIN handyman_execution_scopes s ON s.id=c.execution_scope_id AND s.client_id=c.client_id
          JOIN users u ON u.id=actor_uuid AND u.status='ACTIVE'
          JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
          JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
          JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
          JOIN permissions p ON p.id=rpa.permission_id AND p.status='ACTIVE' AND p.code='handyman.warranty.assess'
          JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.building_id=s.building_id AND uba.status='ACTIVE'
          JOIN buildings bu ON bu.id=uba.building_id AND bu.status='ACTIVE'
          JOIN properties pr ON pr.id=bu.property_id AND pr.client_id=c.client_id
          WHERE c.id=claim_uuid AND u.id<>c.claimant_user_id AND u.id<>c.opened_by_user_id
            AND NOT EXISTS (SELECT 1 FROM tenant_pics tp WHERE tp.user_id=u.id AND tp.status='ACTIVE'
              AND tp.tenant_company_id=s.tenant_company_id))
      $$;
      CREATE FUNCTION hm_warranty_claim_assessment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE c handyman_service_warranty_claims%ROWTYPE; b handyman_warranty_claim_bindings%ROWTYPE;
      BEGIN
        SELECT * INTO c FROM handyman_service_warranty_claims WHERE id=NEW.claim_id FOR UPDATE;
        SELECT * INTO b FROM handyman_warranty_claim_bindings WHERE claim_id=NEW.claim_id;
        IF c.id IS NULL OR b.claim_id IS NULL OR c.status<>'CLAIM_SUBMITTED'
          OR NEW.claim_submitted_at IS DISTINCT FROM c.submitted_at
          OR NOT hm_warranty_certificate_is_current(b.certificate_id)
          OR NEW.revision<>(SELECT COALESCE(max(a.revision),0)+1 FROM handyman_warranty_claim_assessments a WHERE a.claim_id=c.id)
          OR NEW.claim_evidence->>'recordId' IS DISTINCT FROM c.evidence_record_id::text
          OR NOT hm_warranty_assessment_evidence_valid(NEW.claim_evidence,c.client_id,c.execution_scope_id,NEW.result<>'NEEDS_EVIDENCE')
          OR NOT hm_warranty_assessment_evidence_valid(NEW.review_evidence,c.client_id,c.execution_scope_id,NEW.result<>'NEEDS_EVIDENCE')
          OR (NEW.result='COVERED' AND NOT hm_warranty_claim_in_period(c.submitted_at,b.starts_at,b.ends_at_exclusive))
        THEN RAISE EXCEPTION 'Assessment requires the submitted claim, its exact terms and scope-bound evidence.' USING ERRCODE='23514'; END IF;
        IF NOT hm_warranty_claim_assessor_authorized(c.id,NEW.reviewer_user_id) THEN
          RAISE EXCEPTION 'An independent, explicitly authorized warranty assessor for the exact Building is required.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_claim_assessment_insert BEFORE INSERT ON handyman_warranty_claim_assessments
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_claim_assessment_insert_guard();
      CREATE FUNCTION hm_warranty_claim_assessment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Warranty claim bindings and assessments are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_warranty_claim_binding_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_claim_bindings
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_claim_assessment_immutable();
      CREATE TRIGGER hm_warranty_claim_assessment_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_claim_assessments
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_claim_assessment_immutable();
      CREATE FUNCTION hm_warranty_claim_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Warranty claim bindings and assessments are immutable.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_warranty_claim_binding_no_truncate BEFORE TRUNCATE ON handyman_warranty_claim_bindings
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_claim_no_truncate();
      CREATE TRIGGER hm_warranty_claim_assessment_no_truncate BEFORE TRUNCATE ON handyman_warranty_claim_assessments
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_claim_no_truncate();

      CREATE FUNCTION hm_warranty_claim_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE b handyman_warranty_claim_bindings%ROWTYPE; a handyman_warranty_claim_assessments%ROWTYPE;
      BEGIN
        IF OLD.status='CLAIM_DRAFT' AND NEW.status='CLAIM_SUBMITTED' THEN
          SELECT * INTO b FROM handyman_warranty_claim_bindings WHERE claim_id=NEW.id;
          IF b.claim_id IS NULL OR NEW.evidence_record_id IS NULL OR NEW.submitted_at IS DISTINCT FROM statement_timestamp() OR
            NOT hm_warranty_claim_in_period(NEW.submitted_at,b.starts_at,b.ends_at_exclusive) THEN
            RAISE EXCEPTION 'Claim submission requires evidence and a current contractual item period.' USING ERRCODE='23514';
          END IF;
        END IF;
        IF OLD.status='CLAIM_SUBMITTED' AND (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
          OR NEW.claimant_user_id IS DISTINCT FROM OLD.claimant_user_id
          OR NEW.evidence_record_id IS DISTINCT FROM OLD.evidence_record_id) THEN
          RAISE EXCEPTION 'The actual claim submission time, claimant and evidence are immutable.' USING ERRCODE='23514';
        END IF;
        IF NEW.status IN ('CLAIM_APPROVED','CLAIM_REJECTED') AND OLD.status='CLAIM_SUBMITTED' THEN
          SELECT * INTO a FROM handyman_warranty_claim_assessments WHERE id=NEW.decision_assessment_id AND claim_id=NEW.id;
          SELECT * INTO b FROM handyman_warranty_claim_bindings WHERE claim_id=NEW.id;
          IF a.id IS NULL OR b.claim_id IS NULL OR NOT hm_warranty_claim_assessor_authorized(NEW.id,NEW.decided_by_user_id)
            OR NOT hm_warranty_certificate_is_current(b.certificate_id) OR a.revision IS DISTINCT FROM
              (SELECT max(revision) FROM handyman_warranty_claim_assessments WHERE claim_id=NEW.id)
            OR (NEW.status='CLAIM_APPROVED' AND a.result IS DISTINCT FROM 'COVERED')
            OR (NEW.status='CLAIM_REJECTED' AND a.result IS DISTINCT FROM 'REJECTED')
            OR a.claim_submitted_at IS DISTINCT FROM NEW.submitted_at
            OR (NEW.status='CLAIM_APPROVED' AND NOT hm_warranty_claim_in_period(NEW.submitted_at,b.starts_at,b.ends_at_exclusive)) THEN
            RAISE EXCEPTION 'Claim decision requires its latest matching authoritative assessment.' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.decision_assessment_id IS DISTINCT FROM OLD.decision_assessment_id THEN
          RAISE EXCEPTION 'A decision assessment is only bound by a claim decision.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_claim_decision_guard BEFORE UPDATE ON handyman_service_warranty_claims
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_claim_decision_guard();

      CREATE FUNCTION hm_warranty_claim_has_covered_approval(claim_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_service_warranty_claims c
          JOIN handyman_warranty_claim_bindings b ON b.claim_id=c.id
          JOIN handyman_warranty_claim_assessments a ON a.id=c.decision_assessment_id AND a.claim_id=c.id
          JOIN handyman_warranty_certificates d ON d.id=b.certificate_id AND d.warranty_id=c.warranty_id
            AND d.client_id=c.client_id AND d.execution_scope_id=c.execution_scope_id AND d.bast_id=c.bast_id
            AND d.source_sha256=b.certificate_source_sha256 AND d.pdf_sha256=b.certificate_pdf_sha256
          WHERE c.id=claim_uuid AND c.status='CLAIM_APPROVED' AND a.result='COVERED'
            AND hm_warranty_certificate_is_current(d.id)
            AND a.claim_submitted_at=c.submitted_at AND hm_warranty_claim_in_period(c.submitted_at,b.starts_at,b.ends_at_exclusive)
            AND a.conditions_disposition='SATISFIED' AND a.exclusions_disposition='NOT_APPLICABLE'
            AND hm_warranty_assessment_evidence_valid(a.claim_evidence,c.client_id,c.execution_scope_id,true)
            AND hm_warranty_assessment_evidence_valid(a.review_evidence,c.client_id,c.execution_scope_id,true))
      $$;
      CREATE FUNCTION hm_warranty_rework_assessment_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.status='REWORK_DRAFT' AND NEW.status='REWORK_AUTHORIZED'))
          AND NOT hm_warranty_claim_has_covered_approval(NEW.claim_id) THEN
          RAISE EXCEPTION 'Warranty rework requires an approved claim with authoritative covered assessment.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_assessment_gate BEFORE INSERT OR UPDATE ON handyman_service_warranty_reworks
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_assessment_gate();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_warranty_claim_bindings, handyman_warranty_claim_assessments IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_warranty_claim_bindings) OR EXISTS (SELECT 1 FROM handyman_warranty_claim_assessments)
        THEN RAISE EXCEPTION 'Cannot discard warranty claim assessment history.'; END IF; END $$;
      DROP TRIGGER hm_warranty_rework_assessment_gate ON handyman_service_warranty_reworks;
      DROP TRIGGER hm_warranty_claim_decision_guard ON handyman_service_warranty_claims;
      DROP TRIGGER hm_warranty_claim_binding_required ON handyman_service_warranty_claims;
      ALTER TABLE handyman_service_warranty_claims DROP CONSTRAINT hm_warranty_claim_decision_assessment_fk;
      ALTER TABLE handyman_service_warranty_claims DROP COLUMN decision_assessment_id;
      DROP TABLE handyman_warranty_claim_assessments; DROP TABLE handyman_warranty_claim_bindings;
      DROP FUNCTION hm_warranty_rework_assessment_gate(); DROP FUNCTION hm_warranty_claim_has_covered_approval(UUID);
      DROP FUNCTION hm_warranty_claim_decision_guard(); DROP FUNCTION hm_warranty_claim_binding_required();
      DROP FUNCTION hm_warranty_claim_assessment_insert_guard(); DROP FUNCTION hm_warranty_claim_assessor_authorized(UUID,UUID); DROP FUNCTION hm_warranty_assessment_evidence_valid(JSONB,UUID,UUID,BOOLEAN);
      DROP FUNCTION hm_warranty_claim_binding_guard(); DROP FUNCTION hm_warranty_certificate_is_current(UUID); DROP FUNCTION hm_warranty_claim_in_period(TIMESTAMPTZ,TIMESTAMPTZ,TIMESTAMPTZ);
      DROP FUNCTION hm_warranty_claim_assessment_immutable(); DROP FUNCTION hm_warranty_claim_no_truncate();
    `);
  },
};
