import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Item-level execution declarations, their reviewable snapshots, and the exact
 * Supervisor PASS binding. This does not backfill historic QC or BAST facts. */
export const migration0515HandymanCompletionManifest: Migration = {
  id: '0515_handyman_completion_manifest',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_completion_declarations (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        quotation_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        variation_id UUID REFERENCES handyman_scope_variations(id),
        approved_qty NUMERIC NOT NULL CHECK (approved_qty > 0),
        actual_qty NUMERIC NOT NULL CHECK (actual_qty >= 0 AND actual_qty <= approved_qty),
        status TEXT NOT NULL CHECK (status IN ('COMPLETED','PARTIAL','NOT_PERFORMED')),
        work_session_id UUID NOT NULL REFERENCES handyman_work_sessions(id),
        assignment_id UUID NOT NULL REFERENCES handyman_execution_scope_assignments(id),
        lead_worker_id UUID NOT NULL REFERENCES handyman_worker_contexts(id),
        lead_user_id UUID NOT NULL REFERENCES users(id),
        evidence_id UUID NOT NULL REFERENCES handyman_field_evidence_uploads(id),
        evidence_reference TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (execution_scope_id, idempotency_key),
        CHECK ((actual_qty = 0 AND status = 'NOT_PERFORMED') OR
               (actual_qty > 0 AND actual_qty < approved_qty AND status = 'PARTIAL') OR
               (actual_qty = approved_qty AND status = 'COMPLETED'))
      );
      CREATE INDEX hm_completion_declaration_scope ON handyman_completion_declarations(execution_scope_id, quotation_line_id);
      CREATE TABLE handyman_completion_revocations (
        id UUID PRIMARY KEY,
        declaration_id UUID NOT NULL UNIQUE REFERENCES handyman_completion_declarations(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        revoked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (execution_scope_id,idempotency_key)
      );
      CREATE TABLE handyman_completion_manifests (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        version INTEGER NOT NULL CHECK (version > 0),
        source_snapshot JSONB NOT NULL,
        source_canonical TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
        submitted_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (execution_scope_id,version),
        UNIQUE (execution_scope_id,idempotency_key),
        CHECK (source_canonical::jsonb = source_snapshot),
        CHECK (encode(sha256(convert_to(source_canonical,'UTF8')),'hex') = source_sha256)
      );
      CREATE TABLE handyman_completion_verifications (
        id UUID PRIMARY KEY,
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        manifest_id UUID NOT NULL REFERENCES handyman_completion_manifests(id),
        manifest_version INTEGER NOT NULL CHECK (manifest_version > 0),
        manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
        qc_run_id UUID NOT NULL REFERENCES handyman_qc_runs(id),
        qc_run_version INTEGER NOT NULL CHECK (qc_run_version > 0),
        qc_finish_event_id UUID NOT NULL REFERENCES handyman_qc_run_events(id),
        verified_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (qc_run_id),
        UNIQUE (execution_scope_id,idempotency_key)
      );
      ALTER TABLE handyman_bast_documents ADD COLUMN completion_verification_id UUID
        REFERENCES handyman_completion_verifications(id);

      CREATE FUNCTION hm_completion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_completion_declarations)
          AND NOT EXISTS (SELECT 1 FROM handyman_completion_revocations)
          AND NOT EXISTS (SELECT 1 FROM handyman_completion_manifests)
          AND NOT EXISTS (SELECT 1 FROM handyman_completion_verifications) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Completion evidence and review are append-only.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_completion_declarations_no_write BEFORE UPDATE OR DELETE ON handyman_completion_declarations
        FOR EACH ROW EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_revocations_no_write BEFORE UPDATE OR DELETE ON handyman_completion_revocations
        FOR EACH ROW EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_manifests_no_write BEFORE UPDATE OR DELETE ON handyman_completion_manifests
        FOR EACH ROW EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_verifications_no_write BEFORE UPDATE OR DELETE ON handyman_completion_verifications
        FOR EACH ROW EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_declarations_no_truncate BEFORE TRUNCATE ON handyman_completion_declarations
        FOR EACH STATEMENT EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_revocations_no_truncate BEFORE TRUNCATE ON handyman_completion_revocations
        FOR EACH STATEMENT EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_manifests_no_truncate BEFORE TRUNCATE ON handyman_completion_manifests
        FOR EACH STATEMENT EXECUTE FUNCTION hm_completion_immutable();
      CREATE TRIGGER hm_completion_verifications_no_truncate BEFORE TRUNCATE ON handyman_completion_verifications
        FOR EACH STATEMENT EXECUTE FUNCTION hm_completion_immutable();

      CREATE FUNCTION hm_completion_declaration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE allowed NUMERIC; previous NUMERIC; line_kind TEXT;
      BEGIN
        PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        -- A live session, current assigned Lead and byte-backed work evidence are
        -- mandatory; helper-presence snapshots never confer item authority.
        IF NOT EXISTS (
          SELECT 1 FROM handyman_execution_scopes s
          JOIN handyman_service_requests req ON req.id=s.handyman_request_id AND req.client_id=s.client_id
            AND req.building_id=s.building_id AND req.tenant_company_id=s.tenant_company_id
          JOIN handyman_work_sessions ws ON ws.id=NEW.work_session_id AND ws.execution_scope_id=s.id
            AND ws.client_id=s.client_id AND ws.status='IN_PROGRESS' AND ws.started_work_at IS NOT NULL
          JOIN handyman_execution_scope_assignments a ON a.id=ws.assignment_id AND a.execution_scope_id=s.id AND a.status='ACTIVE'
          JOIN handyman_crew_leads cl ON cl.handyman_crew_id=a.handyman_crew_id
            AND cl.lead_seq=(SELECT MAX(x.lead_seq) FROM handyman_crew_leads x WHERE x.handyman_crew_id=a.handyman_crew_id)
          JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id
            AND cm.status='ACTIVE' AND cm.handyman_worker_context_id=ws.lead_worker_id
          JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id
          JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id AND wp.user_id=ws.lead_user_id
          JOIN handyman_field_evidence_uploads e ON e.id=NEW.evidence_id AND e.client_id=s.client_id
            AND e.building_id=s.building_id AND e.handyman_request_id=s.handyman_request_id
            AND e.execution_scope_id=s.id AND (e.variation_id IS NULL OR e.variation_id=NEW.variation_id)
          WHERE s.id=NEW.execution_scope_id AND s.status='AUTHORIZED'
            AND s.client_id=NEW.client_id AND s.building_id=NEW.building_id AND s.handyman_request_id=NEW.request_id
            AND NEW.assignment_id=ws.assignment_id AND NEW.lead_worker_id=ws.lead_worker_id AND NEW.lead_user_id=ws.lead_user_id
            AND e.purpose='BEFORE_AFTER_WORK' AND e.upload_status='VERIFIED' AND e.verified_byte_size>0
            AND e.uploaded_by_user_id=ws.lead_user_id AND e.uploaded_by_role='PIC_PEKERJAAN'
            AND e.attachment_reference=NEW.evidence_reference AND e.sha256_checksum=NEW.evidence_sha256
            AND e.verified_at>=ws.started_work_at
        ) THEN RAISE EXCEPTION 'Completion requires the assigned Lead, in-progress session and exact work evidence.' USING ERRCODE='23514'; END IF;
        IF NEW.variation_id IS NULL THEN
          SELECT ql.quantity-COALESCE((SELECT SUM(v.quantity) FROM handyman_scope_variations v
            WHERE v.execution_scope_id=s.id AND v.variation_type='REDUCE' AND v.target_quotation_line_id=ql.id
              AND v.tenant_decision_outcome='APPROVED' AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')),0), ql.line_type
            INTO allowed,line_kind FROM handyman_execution_scopes s JOIN handyman_quotation_lines ql
              ON ql.quotation_version_id=s.approved_quotation_version_id
            WHERE s.id=NEW.execution_scope_id AND ql.id=NEW.quotation_line_id AND NEW.quotation_version_id=s.approved_quotation_version_id;
        ELSE
          SELECT v.quantity,ql.line_type INTO allowed,line_kind
            FROM handyman_execution_scopes s JOIN handyman_scope_variations v ON v.execution_scope_id=s.id
            JOIN handyman_quotation_versions qv ON qv.id=v.revised_quotation_version_id AND qv.quotation_id=s.quotation_id
            JOIN handyman_quotation_lines ql ON ql.quotation_version_id=qv.id AND ql.id=NEW.quotation_line_id
            JOIN handyman_scope_variation_events r ON r.variation_id=v.id AND r.event_type='REVISED_QUOTATION' AND r.actor_role='OPERATIONS_MANAGER'
            JOIN handyman_scope_variation_events d ON d.variation_id=v.id AND d.event_type='TENANT_DECISION' AND d.actor_role='TENANT'
            JOIN handyman_scope_variation_events a ON a.variation_id=v.id AND a.event_type='AUTHORIZED_SCOPE' AND a.actor_role='OPERATIONS_MANAGER'
            WHERE s.id=NEW.execution_scope_id AND v.id=NEW.variation_id AND v.client_id=s.client_id AND v.building_id=s.building_id
              AND v.handyman_request_id=s.handyman_request_id AND v.tenant_company_id=s.tenant_company_id
              AND v.variation_type='ADD' AND v.tenant_decision_outcome='APPROVED'
              AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
              AND qv.id=NEW.quotation_version_id AND ql.line_type=v.line_type AND ql.quantity=v.quantity AND ql.uom_id=v.uom_id
              AND r.metadata->>'revisedQuotationLineId'=ql.id::text AND r.metadata->>'revisedQuotationVersionId'=qv.id::text
              AND d.actor_user_id=v.tenant_decided_by_user_id AND d.metadata->>'decisionOutcome'='APPROVED'
              AND d.metadata->'consentSnapshot'->>'revisedQuotationLineId'=ql.id::text
              AND d.metadata->'consentSnapshot'->>'revisedQuotationVersionId'=qv.id::text;
          -- Positive ADD labor is already captured by the authoritative ADD
          -- labor execution; do not invent a second item-level evidence source.
          IF line_kind='LABOR' AND NEW.actual_qty>0 THEN
            RAISE EXCEPTION 'Use the existing ADD labor execution record.' USING ERRCODE='23514'; END IF;
        END IF;
        IF allowed IS NULL OR allowed<=0 OR NEW.approved_qty<>allowed THEN
          RAISE EXCEPTION 'Completion line is not an exact approved scope item.' USING ERRCODE='23514'; END IF;
        IF EXISTS (SELECT 1 FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
          WHERE d.execution_scope_id=NEW.execution_scope_id AND r.id IS NULL
            AND (d.evidence_id=NEW.evidence_id OR (d.quotation_line_id=NEW.quotation_line_id AND d.work_session_id=NEW.work_session_id)))
          OR EXISTS (SELECT 1 FROM handyman_add_labor_executions l WHERE l.evidence_id=NEW.evidence_id) THEN
          RAISE EXCEPTION 'Duplicate completion item or evidence.' USING ERRCODE='23514'; END IF;
        SELECT COALESCE(SUM(d.actual_qty),0) INTO previous FROM handyman_completion_declarations d
          LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
          WHERE d.execution_scope_id=NEW.execution_scope_id AND d.quotation_line_id=NEW.quotation_line_id AND r.id IS NULL;
        SELECT previous+COALESCE(SUM(l.actual_qty),0) INTO previous FROM handyman_add_labor_executions l
          WHERE l.execution_scope_id=NEW.execution_scope_id AND l.quotation_line_id=NEW.quotation_line_id;
        IF previous+NEW.actual_qty>allowed OR (NEW.actual_qty=0 AND previous>0)
          OR EXISTS (SELECT 1 FROM handyman_completion_declarations d
            LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id WHERE d.execution_scope_id=NEW.execution_scope_id
              AND d.quotation_line_id=NEW.quotation_line_id AND d.actual_qty=0 AND r.id IS NULL) THEN
          RAISE EXCEPTION 'Completion quantity exceeds or contradicts approved scope.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_completion_declaration_guard BEFORE INSERT ON handyman_completion_declarations
        FOR EACH ROW EXECUTE FUNCTION hm_completion_declaration_guard();

      CREATE FUNCTION hm_completion_revocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM handyman_completion_declarations d WHERE d.id=NEW.declaration_id
          AND d.execution_scope_id=NEW.execution_scope_id AND d.lead_user_id=NEW.actor_user_id) THEN
          RAISE EXCEPTION 'Only the declaring Lead can revoke a declaration.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_completion_revocation_guard BEFORE INSERT ON handyman_completion_revocations
        FOR EACH ROW EXECUTE FUNCTION hm_completion_revocation_guard();

      -- The older ADD labor writer and the new declaration writer share the
      -- same evidence/NOT_PERFORMED boundary in either insertion order.
      CREATE FUNCTION hm_add_labor_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        IF EXISTS (SELECT 1 FROM handyman_completion_declarations d
          LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
          WHERE d.execution_scope_id=NEW.execution_scope_id AND r.id IS NULL
            AND (d.evidence_id=NEW.evidence_id OR (d.variation_id=NEW.variation_id AND d.actual_qty=0))) THEN
          RAISE EXCEPTION 'ADD labor contradicts a completion declaration or reuses its evidence.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_add_labor_completion_guard BEFORE INSERT ON handyman_add_labor_executions
        FOR EACH ROW EXECUTE FUNCTION hm_add_labor_completion_guard();

      CREATE FUNCTION hm_completion_manifest_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM handyman_execution_scopes s JOIN handyman_service_requests r
          ON r.id=s.handyman_request_id AND r.client_id=s.client_id AND r.building_id=s.building_id
          WHERE s.id=NEW.execution_scope_id AND s.client_id=NEW.client_id AND s.building_id=NEW.building_id
            AND s.handyman_request_id=NEW.request_id AND s.status='AUTHORIZED') OR
          NEW.version <> COALESCE((SELECT MAX(version)+1 FROM handyman_completion_manifests
            WHERE execution_scope_id=NEW.execution_scope_id),1) THEN
          RAISE EXCEPTION 'Completion manifest scope or version mismatch.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_completion_manifest_binding BEFORE INSERT ON handyman_completion_manifests
        FOR EACH ROW EXECUTE FUNCTION hm_completion_manifest_binding();

      -- Direct ISSUE cannot reuse a review after a declaration was revoked,
      -- another execution fact was added, or authorized scope changed.
      CREATE FUNCTION hm_completion_sources_current(manifest UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
        SELECT NOT EXISTS (
          SELECT d.id::text FROM handyman_completion_declarations d
            LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
            WHERE d.execution_scope_id=m.execution_scope_id AND r.id IS NULL
          EXCEPT SELECT p->>'id' FROM jsonb_array_elements(m.source_snapshot->'items') i,
            LATERAL jsonb_array_elements(i->'execution') p WHERE p->>'source'='CREW_DECLARATION'
        ) AND NOT EXISTS (
          SELECT p->>'id' FROM jsonb_array_elements(m.source_snapshot->'items') i,
            LATERAL jsonb_array_elements(i->'execution') p WHERE p->>'source'='CREW_DECLARATION'
          EXCEPT SELECT d.id::text FROM handyman_completion_declarations d
            LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
            WHERE d.execution_scope_id=m.execution_scope_id AND r.id IS NULL
        ) AND NOT EXISTS (
          SELECT l.id::text FROM handyman_add_labor_executions l WHERE l.execution_scope_id=m.execution_scope_id
          EXCEPT SELECT p->>'id' FROM jsonb_array_elements(m.source_snapshot->'items') i,
            LATERAL jsonb_array_elements(i->'execution') p WHERE p->>'source'='ADD_LABOR_EXECUTION'
        ) AND NOT EXISTS (
          SELECT p->>'id' FROM jsonb_array_elements(m.source_snapshot->'items') i,
            LATERAL jsonb_array_elements(i->'execution') p WHERE p->>'source'='ADD_LABOR_EXECUTION'
          EXCEPT SELECT l.id::text FROM handyman_add_labor_executions l WHERE l.execution_scope_id=m.execution_scope_id
        ) AND NOT EXISTS (
          SELECT v.id::text FROM handyman_scope_variations v WHERE v.execution_scope_id=m.execution_scope_id
            AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
          EXCEPT SELECT v->>'id' FROM jsonb_array_elements(m.source_snapshot->'approvedVariations') v
        ) AND NOT EXISTS (
          SELECT v->>'id' FROM jsonb_array_elements(m.source_snapshot->'approvedVariations') v
          EXCEPT SELECT v.id::text FROM handyman_scope_variations v WHERE v.execution_scope_id=m.execution_scope_id
            AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')
        ) AND NOT EXISTS (
          SELECT ws.id::text FROM handyman_work_sessions ws WHERE ws.execution_scope_id=m.execution_scope_id
          EXCEPT SELECT x->>'id' FROM jsonb_array_elements(m.source_snapshot->'sessions') x
        ) AND NOT EXISTS (
          SELECT x->>'id' FROM jsonb_array_elements(m.source_snapshot->'sessions') x
          EXCEPT SELECT ws.id::text FROM handyman_work_sessions ws WHERE ws.execution_scope_id=m.execution_scope_id
        ) AND NOT EXISTS (
          SELECT 1 FROM handyman_work_sessions ws WHERE ws.execution_scope_id=m.execution_scope_id
            AND (ws.completed_at IS NULL OR ws.status NOT IN ('COMPLETED','CHECKED_OUT'))
        ) FROM handyman_completion_manifests m WHERE m.id=manifest;
      $$;

      CREATE FUNCTION hm_completion_verification_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM handyman_completion_manifests m
          JOIN handyman_qc_runs q ON q.id=NEW.qc_run_id AND q.execution_scope_id=m.execution_scope_id AND q.client_id=m.client_id
          JOIN handyman_qc_run_events e ON e.id=NEW.qc_finish_event_id AND e.run_id=q.id AND e.event_type='FINISH'
          WHERE m.id=NEW.manifest_id AND m.execution_scope_id=NEW.execution_scope_id
            AND m.version=NEW.manifest_version AND m.source_sha256=NEW.manifest_sha256
            AND m.version=(SELECT MAX(x.version) FROM handyman_completion_manifests x WHERE x.execution_scope_id=m.execution_scope_id)
            AND q.status='PASSED' AND q.version=NEW.qc_run_version AND e.metadata->>'outcome'='PASSED'
            AND hm_completion_sources_current(m.id)
            AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions ws WHERE ws.execution_scope_id=q.execution_scope_id
              AND (ws.completed_at IS NULL OR ws.completed_at>e.occurred_at))
            AND q.id=(SELECT x.id FROM handyman_qc_runs x WHERE x.execution_scope_id=q.execution_scope_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
        ) THEN RAISE EXCEPTION 'Completion verification must bind the current manifest and exact QC PASS.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_completion_verification_binding BEFORE INSERT ON handyman_completion_verifications
        FOR EACH ROW EXECUTE FUNCTION hm_completion_verification_binding();

      CREATE FUNCTION hm_bast_completion_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.completion_verification_id IS NOT NULL AND NEW.completion_verification_id IS DISTINCT FROM OLD.completion_verification_id THEN
          RAISE EXCEPTION 'BAST completion provenance is immutable.' USING ERRCODE='23514'; END IF;
        IF NEW.status='ISSUED' AND OLD.status IS DISTINCT FROM NEW.status THEN
          PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
          IF NOT EXISTS (SELECT 1 FROM handyman_completion_verifications v
            JOIN handyman_completion_manifests m ON m.id=v.manifest_id
            JOIN handyman_qc_runs q ON q.id=v.qc_run_id
            JOIN handyman_qc_run_events e ON e.id=v.qc_finish_event_id AND e.run_id=q.id AND e.event_type='FINISH'
            WHERE v.id=NEW.completion_verification_id AND v.execution_scope_id=NEW.execution_scope_id
              AND v.qc_run_id=NEW.qc_run_id AND q.status='PASSED' AND q.version=v.qc_run_version
              AND m.version=(SELECT MAX(x.version) FROM handyman_completion_manifests x WHERE x.execution_scope_id=m.execution_scope_id)
              AND hm_completion_sources_current(m.id)
              AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions ws WHERE ws.execution_scope_id=q.execution_scope_id
                AND (ws.completed_at IS NULL OR ws.completed_at>e.occurred_at))
          ) THEN RAISE EXCEPTION 'New BAST issue requires the latest verified completion manifest.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_bast_completion_gate BEFORE UPDATE ON handyman_bast_documents
        FOR EACH ROW EXECUTE FUNCTION hm_bast_completion_gate();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_completion_declarations,handyman_completion_revocations,handyman_completion_manifests,handyman_completion_verifications IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_completion_declarations) OR EXISTS (SELECT 1 FROM handyman_completion_revocations)
        OR EXISTS (SELECT 1 FROM handyman_completion_manifests) OR EXISTS (SELECT 1 FROM handyman_completion_verifications) THEN
        RAISE EXCEPTION 'Cannot discard completion history.'; END IF; END; $$;
      DROP TRIGGER hm_bast_completion_gate ON handyman_bast_documents;
      DROP FUNCTION hm_bast_completion_gate();
      ALTER TABLE handyman_bast_documents DROP COLUMN completion_verification_id;
      DROP TRIGGER hm_add_labor_completion_guard ON handyman_add_labor_executions;
      DROP FUNCTION hm_add_labor_completion_guard();
      DROP FUNCTION hm_completion_sources_current(UUID);
      DROP TABLE handyman_completion_verifications,handyman_completion_manifests,handyman_completion_revocations,handyman_completion_declarations;
      DROP FUNCTION hm_completion_verification_binding();
      DROP FUNCTION hm_completion_manifest_binding();
      DROP FUNCTION hm_completion_revocation_guard();
      DROP FUNCTION hm_completion_declaration_guard();
      DROP FUNCTION hm_completion_immutable();
    `);
  },
};
