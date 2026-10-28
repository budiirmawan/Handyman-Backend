import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A prospective, free rework is a separate operational scope, not a new offer. */
export const migration0525HandymanWarrantyReworkExecution: Migration = {
  id: '0525_handyman_warranty_rework_execution',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_execution_scopes
        ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'ORIGINAL' CHECK (scope_kind IN ('ORIGINAL','WARRANTY_REWORK')),
        ADD COLUMN warranty_rework_id UUID REFERENCES handyman_service_warranty_reworks(id),
        ADD COLUMN warranty_rework_key TEXT,
        ADD CONSTRAINT hm_rework_scope_kind_check CHECK (
          (scope_kind='ORIGINAL' AND warranty_rework_id IS NULL AND warranty_rework_key IS NULL) OR
          (scope_kind='WARRANTY_REWORK' AND warranty_rework_id IS NOT NULL AND
           length(btrim(warranty_rework_key)) BETWEEN 1 AND 200));
      ALTER TABLE handyman_execution_scopes DROP CONSTRAINT handyman_execution_scopes_version_unique;
      CREATE UNIQUE INDEX handyman_execution_scopes_original_version_unique
        ON handyman_execution_scopes (approved_quotation_version_id) WHERE scope_kind='ORIGINAL';
      CREATE UNIQUE INDEX handyman_execution_scopes_rework_unique
        ON handyman_execution_scopes (warranty_rework_id) WHERE scope_kind='WARRANTY_REWORK';

      CREATE TABLE handyman_warranty_rework_executions (
        execution_scope_id UUID PRIMARY KEY REFERENCES handyman_execution_scopes(id),
        rework_id UUID NOT NULL UNIQUE REFERENCES handyman_service_warranty_reworks(id),
        original_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        claim_id UUID NOT NULL REFERENCES handyman_service_warranty_claims(id),
        assessment_id UUID NOT NULL REFERENCES handyman_warranty_claim_assessments(id),
        certificate_id UUID NOT NULL REFERENCES handyman_warranty_certificates(id),
        item_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        coverage_kind TEXT NOT NULL CHECK (coverage_kind IN ('LABOR','PARTS')),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_rework_scope_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scope_kind='ORIGINAL' THEN RETURN NEW; END IF;
        IF NEW.status <> 'AUTHORIZED' OR NEW.created_by_user_id IS NULL OR NEW.created_by_care_actor_id IS NOT NULL OR
          NOT EXISTS (SELECT 1 FROM handyman_service_warranty_reworks r
            JOIN handyman_service_warranty_claims c ON c.id=r.claim_id AND c.client_id=r.client_id
            JOIN handyman_warranty_claim_bindings b ON b.claim_id=c.id
            JOIN handyman_execution_scopes o ON o.id=r.execution_scope_id AND o.scope_kind='ORIGINAL'
            JOIN users u ON u.id=NEW.created_by_user_id AND u.status='ACTIVE'
            JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.building_id=o.building_id AND uba.status='ACTIVE'
            JOIN buildings bl ON bl.id=uba.building_id AND bl.status='ACTIVE'
            JOIN properties p ON p.id=bl.property_id AND p.client_id=o.client_id
            WHERE r.id=NEW.warranty_rework_id AND r.status='REWORK_AUTHORIZED'
              AND hm_warranty_claim_has_covered_approval(c.id)
              AND NEW.client_id=o.client_id AND NEW.handyman_request_id=o.handyman_request_id
              AND NEW.channel_attribution_id=o.channel_attribution_id AND NEW.quotation_id=o.quotation_id
              AND NEW.approved_quotation_version_id=o.approved_quotation_version_id
              AND NEW.quotation_decision_id=o.quotation_decision_id AND NEW.tenant_company_id=o.tenant_company_id
              AND NEW.tenant_pic_id IS NOT DISTINCT FROM o.tenant_pic_id AND NEW.building_id=o.building_id
              AND NEW.floor_id IS NOT DISTINCT FROM o.floor_id AND NEW.area_id IS NOT DISTINCT FROM o.area_id
              AND NEW.room_id IS NOT DISTINCT FROM o.room_id AND NEW.space_id IS NOT DISTINCT FROM o.space_id
              AND NOT EXISTS (SELECT 1 FROM tenant_pics pic WHERE pic.user_id=u.id
                AND pic.tenant_company_id=o.tenant_company_id AND pic.status='ACTIVE')
              AND (SELECT count(DISTINCT perm.code) FROM user_role_assignments ura
                JOIN roles role ON role.id=ura.role_id AND role.status='ACTIVE'
                JOIN role_permission_assignments rpa ON rpa.role_id=role.id AND rpa.status='ACTIVE'
                JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE'
                WHERE ura.user_id=u.id AND ura.status='ACTIVE'
                  AND perm.code IN ('tenant_company.manage','handyman.commercial.manage'))=2
          ) THEN RAISE EXCEPTION 'Rework scope requires exact approved claim, original lineage and authorized Operations actor.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_scope_insert BEFORE INSERT ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_scope_insert_guard();
      CREATE FUNCTION hm_warranty_rework_scope_bind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scope_kind='WARRANTY_REWORK' THEN
          INSERT INTO handyman_warranty_rework_executions
            (execution_scope_id,rework_id,original_scope_id,claim_id,assessment_id,certificate_id,item_line_id,
             coverage_kind,client_id,building_id,created_by_user_id,idempotency_key)
          SELECT NEW.id,r.id,r.execution_scope_id,c.id,c.decision_assessment_id,b.certificate_id,b.item_line_id,
            b.coverage_kind,NEW.client_id,NEW.building_id,NEW.created_by_user_id,NEW.warranty_rework_key
          FROM handyman_service_warranty_reworks r JOIN handyman_service_warranty_claims c ON c.id=r.claim_id
          JOIN handyman_warranty_claim_bindings b ON b.claim_id=c.id WHERE r.id=NEW.warranty_rework_id;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_scope_bind AFTER INSERT ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_scope_bind();
      CREATE FUNCTION hm_warranty_rework_scope_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.warranty_rework_id IS DISTINCT FROM OLD.warranty_rework_id OR
          NEW.warranty_rework_key IS DISTINCT FROM OLD.warranty_rework_key THEN
          RAISE EXCEPTION 'Rework scope lineage is immutable.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_scope_immutable BEFORE UPDATE ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_scope_immutable();
      CREATE FUNCTION hm_warranty_rework_scope_current(scope_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id AND s.scope_kind='WARRANTY_REWORK'
            AND s.warranty_rework_id=x.rework_id AND s.client_id=x.client_id AND s.building_id=x.building_id
          JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id AND r.claim_id=x.claim_id
            AND r.execution_scope_id=x.original_scope_id
          JOIN handyman_service_warranty_claims c ON c.id=x.claim_id AND c.decision_assessment_id=x.assessment_id
          JOIN handyman_warranty_claim_bindings b ON b.claim_id=c.id AND b.certificate_id=x.certificate_id
            AND b.item_line_id=x.item_line_id AND b.coverage_kind=x.coverage_kind
          WHERE x.execution_scope_id=scope_uuid AND r.status IN ('REWORK_AUTHORIZED','REWORK_IN_PROGRESS','REWORK_COMPLETE')
            AND hm_warranty_claim_has_covered_approval(c.id))
      $$;

      CREATE TABLE handyman_warranty_rework_completions (
        id UUID PRIMARY KEY,
        rework_id UUID NOT NULL UNIQUE REFERENCES handyman_service_warranty_reworks(id),
        execution_scope_id UUID NOT NULL UNIQUE REFERENCES handyman_warranty_rework_executions(execution_scope_id),
        session_id UUID REFERENCES handyman_work_sessions(id),
        arrival_result_id UUID NOT NULL REFERENCES handyman_arrival_verification_results(id),
        assignment_id UUID NOT NULL REFERENCES handyman_execution_scope_assignments(id),
        lead_user_id UUID NOT NULL REFERENCES users(id),
        evidence_upload_id UUID NOT NULL REFERENCES handyman_field_evidence_uploads(id),
        evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_rework_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id AND r.status='REWORK_IN_PROGRESS'
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
          JOIN handyman_execution_scope_assignments a ON a.id=NEW.assignment_id AND a.execution_scope_id=s.id AND a.status='ACTIVE'
          JOIN handyman_arrival_verification_results ar ON ar.id=NEW.arrival_result_id
            AND ar.execution_scope_id=s.id AND ar.assignment_id=a.id AND ar.actor_user_id=NEW.lead_user_id
            AND ar.status='VERIFIED' AND ar.evaluated_at<=r.started_at AND ar.evaluated_at>=a.assigned_at
          JOIN handyman_field_evidence_uploads e ON e.id=NEW.evidence_upload_id AND e.execution_scope_id=s.id
            AND e.client_id=s.client_id AND e.building_id=s.building_id AND e.handyman_request_id=s.handyman_request_id
            AND e.uploaded_by_user_id=NEW.lead_user_id AND e.uploaded_by_role='PIC_PEKERJAAN'
            AND e.purpose='BEFORE_AFTER_WORK' AND e.upload_status='VERIFIED' AND e.verified_byte_size>0
            AND e.sha256_checksum=NEW.evidence_sha256 AND e.verified_at>=r.started_at
          WHERE x.execution_scope_id=NEW.execution_scope_id AND x.rework_id=NEW.rework_id
            AND hm_warranty_rework_scope_current(s.id)
            AND NOT EXISTS (SELECT 1 FROM handyman_assignment_responses resp WHERE resp.assignment_id=a.id
              AND resp.assignment_target_type='EXECUTION_SCOPE_ASSIGNMENT' AND resp.response_status='TIDAK_BISA')
            AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions w WHERE w.execution_scope_id=s.id
              AND (w.completed_at IS NULL OR w.status NOT IN ('COMPLETED','CHECKED_OUT')))
            AND (NEW.session_id IS NULL OR EXISTS (SELECT 1 FROM handyman_work_sessions w
              WHERE w.id=NEW.session_id AND w.execution_scope_id=s.id AND w.assignment_id=a.id
                AND w.lead_user_id=NEW.lead_user_id AND w.started_work_at>=r.started_at AND w.completed_at IS NOT NULL))) THEN
          RAISE EXCEPTION 'Rework completion requires the assigned Lead, verified arrival and fresh verified evidence.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_completion_insert BEFORE INSERT ON handyman_warranty_rework_completions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_completion_guard();
      CREATE FUNCTION hm_warranty_rework_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='REWORK_IN_PROGRESS' AND OLD.status='REWORK_AUTHORIZED' AND NOT EXISTS (
          SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
          JOIN handyman_execution_scope_assignments a ON a.execution_scope_id=s.id AND a.status='ACTIVE'
          JOIN handyman_crew_leads cl ON cl.handyman_crew_id=a.handyman_crew_id
            AND cl.lead_seq=(SELECT max(cl2.lead_seq) FROM handyman_crew_leads cl2 WHERE cl2.handyman_crew_id=a.handyman_crew_id)
          JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id AND cm.status='ACTIVE'
          JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id AND wc.status='ACTIVE'
          JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id AND wp.status='ACTIVE'
          JOIN LATERAL (SELECT ar.* FROM handyman_arrival_verification_results ar
            WHERE ar.execution_scope_id=s.id AND ar.assignment_id=a.id AND ar.actor_user_id=wp.user_id
            ORDER BY ar.evaluated_at DESC,ar.id DESC LIMIT 1) ar ON ar.status='VERIFIED' AND ar.evaluated_at>=a.assigned_at
          JOIN handyman_permit_readiness p ON p.handyman_request_id=s.handyman_request_id AND p.client_id=s.client_id
            AND p.building_id=s.building_id AND p.space_id IS NOT DISTINCT FROM s.space_id AND p.status='ACTIVE'
            AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
          JOIN handyman_unit_access_readiness ua ON ua.handyman_request_id=s.handyman_request_id AND ua.client_id=s.client_id
            AND ua.building_id=s.building_id AND ua.space_id IS NOT DISTINCT FROM s.space_id AND ua.status='ACTIVE'
            AND ua.access_window_start<=clock_timestamp() AND ua.access_window_end>clock_timestamp()
          WHERE x.rework_id=NEW.id AND hm_warranty_rework_scope_current(x.execution_scope_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_assignment_responses resp WHERE resp.assignment_id=a.id
              AND resp.assignment_target_type='EXECUTION_SCOPE_ASSIGNMENT' AND resp.response_status='TIDAK_BISA')) THEN
          RAISE EXCEPTION 'Starting rework requires an assigned Lead, verified arrival and current permit/access.' USING ERRCODE='23514';
        END IF;
        IF NEW.status='REWORK_COMPLETE' AND OLD.status='REWORK_IN_PROGRESS' AND NOT EXISTS (
          SELECT 1 FROM handyman_warranty_rework_completions WHERE rework_id=NEW.id) THEN
          RAISE EXCEPTION 'Rework completion requires new Lead session and evidence.' USING ERRCODE='23514';
        END IF;
        IF NEW.status='REWORK_VERIFIED' AND OLD.status<>'REWORK_VERIFIED' THEN
          RAISE EXCEPTION 'Final warranty claim resolution is not implemented.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_transition BEFORE UPDATE ON handyman_service_warranty_reworks
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_transition_guard();
      CREATE FUNCTION hm_warranty_rework_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id
          WHERE x.execution_scope_id=NEW.execution_scope_id AND r.status<>'REWORK_IN_PROGRESS') THEN
          RAISE EXCEPTION 'Rework sessions require an in-progress rework.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_session BEFORE INSERT ON handyman_work_sessions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_session_guard();
      CREATE FUNCTION hm_warranty_rework_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id
          WHERE x.execution_scope_id=NEW.execution_scope_id AND r.status IN ('REWORK_IN_PROGRESS','REWORK_COMPLETE')) THEN
          RAISE EXCEPTION 'Rework assignment cannot change after execution starts.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_assignment BEFORE INSERT OR UPDATE ON handyman_execution_scope_assignments
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_assignment_guard();

      -- A covered remedy is not a second commercial execution. Prevent the
      -- original quotation from being reused as a new customer charge basis.
      CREATE FUNCTION hm_warranty_rework_noncommercial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_execution_scopes s WHERE s.id=NEW.execution_scope_id AND s.scope_kind='WARRANTY_REWORK') THEN
          RAISE EXCEPTION 'Covered warranty rework is noncommercial; use a separate agreed scope for chargeable work.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_no_transaction BEFORE INSERT ON handyman_customer_transactions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_noncommercial_guard();
      CREATE TRIGGER hm_warranty_rework_no_variation BEFORE INSERT ON handyman_scope_variations
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_noncommercial_guard();
      CREATE TRIGGER hm_warranty_rework_no_commercial_declaration BEFORE INSERT ON handyman_completion_declarations
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_noncommercial_guard();
      CREATE TRIGGER hm_warranty_rework_no_add_labor BEFORE INSERT ON handyman_add_labor_executions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_noncommercial_guard();

      CREATE FUNCTION hm_warranty_rework_response_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ((TG_OP='INSERT' AND NEW.response_status<>'PENDING') OR
            (TG_OP='UPDATE' AND NEW.response_status IS DISTINCT FROM OLD.response_status))
          AND EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x
            JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id
            WHERE x.execution_scope_id=NEW.execution_scope_id AND r.status IN ('REWORK_IN_PROGRESS','REWORK_COMPLETE')) THEN
          RAISE EXCEPTION 'Assignment response cannot change after rework starts.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_response BEFORE INSERT OR UPDATE ON handyman_assignment_responses
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_response_guard();

      CREATE TABLE handyman_warranty_rework_qc_bindings (
        qc_run_id UUID PRIMARY KEY REFERENCES handyman_qc_runs(id),
        completion_id UUID NOT NULL REFERENCES handyman_warranty_rework_completions(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_warranty_rework_executions(execution_scope_id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_rework_qc_bind() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE completion_uuid UUID;
      BEGIN
        IF EXISTS (SELECT 1 FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id) THEN
          SELECT c.id INTO completion_uuid FROM handyman_warranty_rework_completions c
            JOIN handyman_service_warranty_reworks r ON r.id=c.rework_id AND r.status='REWORK_COMPLETE'
            WHERE c.execution_scope_id=NEW.execution_scope_id AND c.completed_at<=NEW.created_at
              AND hm_warranty_rework_scope_current(c.execution_scope_id);
          IF completion_uuid IS NULL THEN
            RAISE EXCEPTION 'Fresh rework QC requires the completed rework evidence first.' USING ERRCODE='23514';
          END IF;
          INSERT INTO handyman_warranty_rework_qc_bindings (qc_run_id,completion_id,execution_scope_id)
            VALUES (NEW.id,completion_uuid,NEW.execution_scope_id);
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_rework_qc_bind AFTER INSERT ON handyman_qc_runs
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_qc_bind();
      CREATE FUNCTION hm_warranty_rework_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Warranty rework execution facts are immutable.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_warranty_rework_execution_immutable BEFORE UPDATE OR DELETE ON handyman_warranty_rework_executions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_immutable();
      CREATE TRIGGER hm_warranty_rework_completion_immutable BEFORE UPDATE OR DELETE ON handyman_warranty_rework_completions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_immutable();
      CREATE TRIGGER hm_warranty_rework_qc_immutable BEFORE UPDATE OR DELETE ON handyman_warranty_rework_qc_bindings
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_rework_immutable();
      CREATE TRIGGER hm_warranty_rework_execution_no_truncate BEFORE TRUNCATE ON handyman_warranty_rework_executions
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_rework_immutable();
      CREATE TRIGGER hm_warranty_rework_completion_no_truncate BEFORE TRUNCATE ON handyman_warranty_rework_completions
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_rework_immutable();
      CREATE TRIGGER hm_warranty_rework_qc_no_truncate BEFORE TRUNCATE ON handyman_warranty_rework_qc_bindings
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_rework_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_warranty_rework_executions) THEN
        RAISE EXCEPTION 'Cannot remove persisted warranty rework execution history.'; END IF; END $$;
      DROP TRIGGER hm_warranty_rework_response ON handyman_assignment_responses;
      DROP FUNCTION hm_warranty_rework_response_guard();
      DROP TRIGGER hm_warranty_rework_no_add_labor ON handyman_add_labor_executions;
      DROP TRIGGER hm_warranty_rework_no_commercial_declaration ON handyman_completion_declarations;
      DROP TRIGGER hm_warranty_rework_no_variation ON handyman_scope_variations;
      DROP TRIGGER hm_warranty_rework_no_transaction ON handyman_customer_transactions;
      DROP FUNCTION hm_warranty_rework_noncommercial_guard();
      DROP TRIGGER hm_warranty_rework_qc_bind ON handyman_qc_runs;
      DROP TRIGGER hm_warranty_rework_assignment ON handyman_execution_scope_assignments;
      DROP TRIGGER hm_warranty_rework_session ON handyman_work_sessions;
      DROP TRIGGER hm_warranty_rework_transition ON handyman_service_warranty_reworks;
      DROP TRIGGER hm_warranty_rework_scope_insert ON handyman_execution_scopes;
      DROP TRIGGER hm_warranty_rework_scope_bind ON handyman_execution_scopes;
      DROP TRIGGER hm_warranty_rework_scope_immutable ON handyman_execution_scopes;
      DROP TABLE handyman_warranty_rework_qc_bindings, handyman_warranty_rework_completions, handyman_warranty_rework_executions;
      DROP FUNCTION hm_warranty_rework_qc_bind(), hm_warranty_rework_assignment_guard(), hm_warranty_rework_session_guard(),
        hm_warranty_rework_transition_guard(), hm_warranty_rework_completion_guard(), hm_warranty_rework_scope_current(UUID),
        hm_warranty_rework_scope_insert_guard(), hm_warranty_rework_scope_bind(), hm_warranty_rework_scope_immutable(), hm_warranty_rework_immutable();
      DROP INDEX handyman_execution_scopes_rework_unique, handyman_execution_scopes_original_version_unique;
      ALTER TABLE handyman_execution_scopes DROP CONSTRAINT hm_rework_scope_kind_check,
        DROP COLUMN warranty_rework_key, DROP COLUMN warranty_rework_id, DROP COLUMN scope_kind;
      ALTER TABLE handyman_execution_scopes ADD CONSTRAINT handyman_execution_scopes_version_unique UNIQUE (approved_quotation_version_id);
    `);
  },
};
