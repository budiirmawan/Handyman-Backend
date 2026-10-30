import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * 0526 and 0527 commit separately. Until the final guard is installed, block
 * prospective rework release/start/session work without changing legacy rows.
 */
export const reworkDispatchMigrationGuardInstall = `
  CREATE OR REPLACE FUNCTION hm_rework_migration_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF (TG_OP='INSERT' OR NEW.status IN ('RELEASED','IN_PROGRESS')) AND EXISTS
      (SELECT 1 FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id) THEN
      RAISE EXCEPTION 'Rework dispatch is paused until the guard migration completes.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END; $$;
  DROP TRIGGER IF EXISTS hm_rework_migration_release ON handyman_dispatch_releases;
  CREATE TRIGGER hm_rework_migration_release BEFORE INSERT OR UPDATE ON handyman_dispatch_releases
    FOR EACH ROW EXECUTE FUNCTION hm_rework_migration_release_guard();

  CREATE OR REPLACE FUNCTION hm_rework_migration_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF (TG_OP='INSERT' OR NEW.status='IN_PROGRESS') AND EXISTS
      (SELECT 1 FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id) THEN
      RAISE EXCEPTION 'Rework sessions are paused until the guard migration completes.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END; $$;
  DROP TRIGGER IF EXISTS hm_rework_migration_session ON handyman_work_sessions;
  CREATE TRIGGER hm_rework_migration_session BEFORE INSERT OR UPDATE ON handyman_work_sessions
    FOR EACH ROW EXECUTE FUNCTION hm_rework_migration_session_guard();

  CREATE OR REPLACE FUNCTION hm_rework_migration_start_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF (OLD.status='REWORK_AUTHORIZED' AND NEW.status='REWORK_IN_PROGRESS') OR
       (OLD.status='REWORK_IN_PROGRESS' AND NEW.status='REWORK_COMPLETE') THEN
      RAISE EXCEPTION 'Rework execution is paused until the guard migration completes.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END; $$;
  DROP TRIGGER IF EXISTS hm_rework_migration_start ON handyman_service_warranty_reworks;
  CREATE TRIGGER hm_rework_migration_start BEFORE UPDATE ON handyman_service_warranty_reworks
    FOR EACH ROW EXECUTE FUNCTION hm_rework_migration_start_guard();
`;
export const reworkDispatchMigrationGuardRemove = `
  DROP TRIGGER IF EXISTS hm_rework_migration_release ON handyman_dispatch_releases;
  DROP FUNCTION IF EXISTS hm_rework_migration_release_guard();
  DROP TRIGGER IF EXISTS hm_rework_migration_session ON handyman_work_sessions;
  DROP FUNCTION IF EXISTS hm_rework_migration_session_guard();
  DROP TRIGGER IF EXISTS hm_rework_migration_start ON handyman_service_warranty_reworks;
  DROP FUNCTION IF EXISTS hm_rework_migration_start_guard();
`;

/** A rework visit is an ordinary visit with a separate, immutable claim/PIC lineage. */
export const migration0526HandymanWarrantyReworkAppointments: Migration = {
  id: '0526_handyman_warranty_rework_appointments',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      -- Preserve pre-existing visits untouched. They have NULL rework identity
      -- and no new binding/consent; the dispatch guard rejects them fail-closed.
      ALTER TABLE handyman_visit_appointments
        ADD COLUMN warranty_rework_id UUID REFERENCES handyman_service_warranty_reworks(id),
        ADD COLUMN warranty_rework_key TEXT;
      DROP INDEX handyman_visit_appointments_one_live_per_request_kind;
      CREATE UNIQUE INDEX handyman_visit_appointments_one_live_per_request_kind
        ON handyman_visit_appointments(handyman_request_id,kind)
        WHERE warranty_rework_id IS NULL AND state IN ('PROPOSED','TENANT_SELECTED','CONFIRMED','IN_PROGRESS');
      CREATE UNIQUE INDEX hm_rework_visit_one_live ON handyman_visit_appointments(warranty_rework_id)
        WHERE warranty_rework_id IS NOT NULL AND state IN ('PROPOSED','TENANT_SELECTED','CONFIRMED','IN_PROGRESS');
      CREATE UNIQUE INDEX hm_rework_visit_key ON handyman_visit_appointments(warranty_rework_id,warranty_rework_key)
        WHERE warranty_rework_id IS NOT NULL;
      CREATE UNIQUE INDEX hm_rework_visit_supersedes ON handyman_visit_appointments(supersedes_appointment_id)
        WHERE warranty_rework_id IS NOT NULL AND supersedes_appointment_id IS NOT NULL;

      CREATE TABLE handyman_warranty_rework_visit_bindings (
        appointment_id UUID PRIMARY KEY REFERENCES handyman_visit_appointments(id),
        rework_id UUID NOT NULL REFERENCES handyman_service_warranty_reworks(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_warranty_rework_executions(execution_scope_id),
        claim_id UUID NOT NULL REFERENCES handyman_service_warranty_claims(id),
        assessment_id UUID NOT NULL REFERENCES handyman_warranty_claim_assessments(id),
        certificate_id UUID NOT NULL REFERENCES handyman_warranty_certificates(id),
        item_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        assignment_id UUID NOT NULL REFERENCES handyman_execution_scope_assignments(id),
        crew_id UUID NOT NULL REFERENCES handyman_work_crews(id),
        lead_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE handyman_warranty_rework_visit_consents (
        id UUID PRIMARY KEY,
        appointment_id UUID NOT NULL UNIQUE REFERENCES handyman_warranty_rework_visit_bindings(appointment_id),
        rework_id UUID NOT NULL REFERENCES handyman_service_warranty_reworks(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_warranty_rework_executions(execution_scope_id),
        claim_id UUID NOT NULL REFERENCES handyman_service_warranty_claims(id),
        assessment_id UUID NOT NULL REFERENCES handyman_warranty_claim_assessments(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        tenant_pic_id UUID NOT NULL REFERENCES tenant_pics(id),
        tenant_user_id UUID NOT NULL REFERENCES users(id),
        tenant_session_id UUID NOT NULL REFERENCES user_sessions(id),
        appointment_version INTEGER NOT NULL CHECK (appointment_version > 0),
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ NOT NULL,
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (end_at>start_at)
      );

      CREATE FUNCTION hm_rework_visit_operations(scope_uuid UUID,actor_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_execution_scopes s
          JOIN users u ON u.id=actor_uuid AND u.status='ACTIVE'
          JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.building_id=s.building_id AND uba.status='ACTIVE'
          JOIN buildings b ON b.id=uba.building_id AND b.status='ACTIVE'
          JOIN properties p ON p.id=b.property_id AND p.client_id=s.client_id
          WHERE s.id=scope_uuid AND NOT EXISTS (SELECT 1 FROM tenant_pics pic WHERE pic.user_id=u.id
            AND pic.tenant_company_id=s.tenant_company_id AND pic.status='ACTIVE')
          AND (SELECT count(DISTINCT perm.code) FROM user_role_assignments ura
            JOIN roles role ON role.id=ura.role_id AND role.status='ACTIVE'
            JOIN role_permission_assignments rpa ON rpa.role_id=role.id AND rpa.status='ACTIVE'
            JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE'
            WHERE ura.user_id=u.id AND ura.status='ACTIVE'
              AND perm.code IN ('tenant_company.manage','handyman.commercial.manage'))=2)
      $$;
      CREATE FUNCTION hm_rework_visit_assignment_current(visit_uuid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_warranty_rework_visit_bindings b
          JOIN handyman_warranty_rework_executions x ON x.execution_scope_id=b.execution_scope_id
            AND x.rework_id=b.rework_id AND x.claim_id=b.claim_id AND x.assessment_id=b.assessment_id
          JOIN handyman_execution_scope_assignments a ON a.id=b.assignment_id AND a.execution_scope_id=b.execution_scope_id
            AND a.handyman_crew_id=b.crew_id AND a.status='ACTIVE'
          JOIN handyman_work_crews crew ON crew.id=b.crew_id AND crew.status='ACTIVE'
            AND crew.handyman_provider_context_id=a.handyman_provider_context_id
          JOIN handyman_crew_leads cl ON cl.handyman_crew_id=crew.id
            AND cl.lead_seq=(SELECT max(l.lead_seq) FROM handyman_crew_leads l WHERE l.handyman_crew_id=crew.id)
          JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id AND cm.status='ACTIVE'
          JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id AND wc.status='ACTIVE'
          JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id AND wp.status='ACTIVE' AND wp.user_id=b.lead_user_id
          JOIN users u ON u.id=wp.user_id AND u.status='ACTIVE'
          JOIN handyman_service_warranty_reworks r ON r.id=b.rework_id AND r.status='REWORK_AUTHORIZED'
          WHERE b.appointment_id=visit_uuid AND hm_warranty_rework_scope_current(x.execution_scope_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_assignment_responses resp
              WHERE resp.assignment_id=a.id AND resp.response_status='TIDAK_BISA'))
      $$;

      CREATE FUNCTION hm_rework_visit_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE x handyman_warranty_rework_executions%ROWTYPE; previous RECORD;
      BEGIN
        IF TG_OP='DELETE' THEN
          IF OLD.warranty_rework_id IS NOT NULL THEN RAISE EXCEPTION 'Rework appointments are historical records.' USING ERRCODE='23514'; END IF;
          RETURN OLD;
        END IF;
        IF TG_OP='UPDATE' THEN
          IF (NEW.warranty_rework_id,NEW.warranty_rework_key) IS DISTINCT FROM (OLD.warranty_rework_id,OLD.warranty_rework_key) THEN
            RAISE EXCEPTION 'Rework appointment identity is immutable.' USING ERRCODE='23514';
          END IF;
          IF OLD.warranty_rework_id IS NOT NULL AND NEW.state='CONFIRMED' AND OLD.state='TENANT_SELECTED' AND
            (NOT hm_rework_visit_operations(NEW.execution_scope_id,NEW.confirmed_by_user_id) OR
             NOT hm_rework_visit_assignment_current(NEW.id)) THEN
            RAISE EXCEPTION 'Rework confirmation requires Operations and the current assigned Lead.' USING ERRCODE='23514';
          END IF;
          IF OLD.warranty_rework_id IS NOT NULL AND NEW.state='CANCELLED' AND OLD.state<>NEW.state AND
            NOT hm_rework_visit_operations(NEW.execution_scope_id,NEW.cancelled_by_user_id) THEN
            RAISE EXCEPTION 'Rework cancellation requires authorized Operations.' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END IF;
        SELECT * INTO x FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id;
        IF x.execution_scope_id IS NULL THEN
          IF NEW.warranty_rework_id IS NOT NULL OR NEW.warranty_rework_key IS NOT NULL THEN
            RAISE EXCEPTION 'Rework appointment requires its rework execution scope.' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END IF;
        IF (NEW.warranty_rework_id IS NOT NULL AND NEW.warranty_rework_id<>x.rework_id) OR
           NEW.warranty_rework_key IS NULL OR length(btrim(NEW.warranty_rework_key)) NOT BETWEEN 1 AND 200 OR
           NEW.kind<>'EXECUTION' OR NEW.state<>'PROPOSED' OR NEW.client_id<>x.client_id OR NEW.building_id<>x.building_id OR
           NOT hm_rework_visit_operations(x.execution_scope_id,NEW.created_by_user_id) OR
           NOT hm_warranty_rework_scope_current(x.execution_scope_id) OR NOT EXISTS (
             SELECT 1 FROM handyman_service_warranty_reworks r WHERE r.id=x.rework_id AND r.status='REWORK_AUTHORIZED') THEN
          RAISE EXCEPTION 'Rework visit requires its current covered claim and authorized execution.' USING ERRCODE='23514';
        END IF;
        NEW.warranty_rework_id := x.rework_id;
        SELECT a.id,a.state INTO previous FROM handyman_visit_appointments a
          WHERE a.warranty_rework_id=x.rework_id AND NOT EXISTS (SELECT 1 FROM handyman_visit_appointments newer
            WHERE newer.warranty_rework_id=x.rework_id AND newer.supersedes_appointment_id=a.id) LIMIT 1;
        IF previous.id IS NULL AND NEW.supersedes_appointment_id IS NOT NULL OR
           previous.id IS NOT NULL AND (previous.state<>'CANCELLED' OR NEW.supersedes_appointment_id IS DISTINCT FROM previous.id) THEN
          RAISE EXCEPTION 'Rework rescheduling must supersede the latest cancelled visit.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_rework_visit_identity BEFORE INSERT OR UPDATE OR DELETE ON handyman_visit_appointments
        FOR EACH ROW EXECUTE FUNCTION hm_rework_visit_identity();
      CREATE FUNCTION hm_rework_visit_bind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.warranty_rework_id IS NULL THEN RETURN NEW; END IF;
        INSERT INTO handyman_warranty_rework_visit_bindings
          (appointment_id,rework_id,execution_scope_id,claim_id,assessment_id,certificate_id,item_line_id,
           client_id,building_id,assignment_id,crew_id,lead_user_id)
        SELECT NEW.id,x.rework_id,x.execution_scope_id,x.claim_id,x.assessment_id,x.certificate_id,x.item_line_id,
          x.client_id,x.building_id,a.id,a.handyman_crew_id,wp.user_id
        FROM handyman_warranty_rework_executions x
        JOIN handyman_execution_scope_assignments a ON a.execution_scope_id=x.execution_scope_id AND a.status='ACTIVE'
          AND a.client_id=x.client_id AND a.handyman_crew_id=NEW.resource_id
        JOIN handyman_work_crews crew ON crew.id=a.handyman_crew_id AND crew.status='ACTIVE'
          AND crew.client_id=x.client_id AND crew.handyman_provider_context_id=a.handyman_provider_context_id
        JOIN handyman_crew_leads cl ON cl.handyman_crew_id=crew.id
          AND cl.lead_seq=(SELECT max(l.lead_seq) FROM handyman_crew_leads l WHERE l.handyman_crew_id=crew.id)
        JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id AND cm.status='ACTIVE'
        JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id AND wc.status='ACTIVE'
        JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id AND wp.status='ACTIVE'
        JOIN users u ON u.id=wp.user_id AND u.status='ACTIVE'
        WHERE x.execution_scope_id=NEW.execution_scope_id AND x.rework_id=NEW.warranty_rework_id
          AND NEW.resource_type='CREW' AND NOT EXISTS (
            SELECT 1 FROM handyman_assignment_responses resp WHERE resp.assignment_id=a.id AND resp.response_status='TIDAK_BISA');
        IF NOT FOUND THEN RAISE EXCEPTION 'Rework visit requires its active assigned Crew Leader.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_rework_visit_bind AFTER INSERT ON handyman_visit_appointments
        FOR EACH ROW EXECUTE FUNCTION hm_rework_visit_bind();
      CREATE FUNCTION hm_rework_visit_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_visit_appointments a
          JOIN handyman_warranty_rework_visit_bindings b ON b.appointment_id=a.id
          JOIN handyman_execution_scopes s ON s.id=b.execution_scope_id
          JOIN tenant_pics pic ON pic.id=s.tenant_pic_id AND pic.tenant_company_id=s.tenant_company_id
            AND pic.user_id=NEW.tenant_user_id AND pic.status='ACTIVE'
          JOIN users u ON u.id=pic.user_id AND u.status='ACTIVE'
          JOIN user_sessions sess ON sess.id=NEW.tenant_session_id AND sess.user_id=u.id
            AND sess.status='ACTIVE' AND sess.expires_at>clock_timestamp()
          WHERE a.id=NEW.appointment_id AND a.state='PROPOSED' AND a.version=NEW.appointment_version
            AND a.start_at=NEW.start_at AND a.end_at=NEW.end_at AND a.start_at>now()
            AND b.rework_id=NEW.rework_id AND b.execution_scope_id=NEW.execution_scope_id
            AND b.claim_id=NEW.claim_id AND b.assessment_id=NEW.assessment_id
            AND b.client_id=NEW.client_id AND b.building_id=NEW.building_id AND pic.id=NEW.tenant_pic_id
            AND hm_warranty_rework_scope_current(b.execution_scope_id) AND hm_rework_visit_assignment_current(a.id)) THEN
          RAISE EXCEPTION 'Rework consent requires the authenticated request PIC and exact proposed visit.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_rework_visit_consent_insert BEFORE INSERT ON handyman_warranty_rework_visit_consents
        FOR EACH ROW EXECUTE FUNCTION hm_rework_visit_consent_guard();
      CREATE FUNCTION hm_rework_visit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Rework visit bindings and consent are immutable.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_rework_visit_binding_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_rework_visit_bindings
        FOR EACH ROW EXECUTE FUNCTION hm_rework_visit_immutable();
      CREATE TRIGGER hm_rework_visit_consent_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_rework_visit_consents
        FOR EACH ROW EXECUTE FUNCTION hm_rework_visit_immutable();
      CREATE TRIGGER hm_rework_visit_binding_no_truncate BEFORE TRUNCATE ON handyman_warranty_rework_visit_bindings
        FOR EACH STATEMENT EXECUTE FUNCTION hm_rework_visit_immutable();
      CREATE TRIGGER hm_rework_visit_consent_no_truncate BEFORE TRUNCATE ON handyman_warranty_rework_visit_consents
        FOR EACH STATEMENT EXECUTE FUNCTION hm_rework_visit_immutable();

      -- The older BM assertion is request-scoped and cannot consent to a rework visit.
      CREATE OR REPLACE FUNCTION handyman_visit_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ap RECORD; cs RECORD;
      BEGIN
        SELECT a.state,a.version,a.kind,a.handyman_request_id,a.tenant_company_id,a.building_id,a.start_at,a.end_at,a.warranty_rework_id INTO ap
          FROM handyman_visit_appointments a WHERE a.id=NEW.appointment_id;
        SELECT c.kind,c.tenant_company_id,c.building_id,c.selected_start_at,c.selected_end_at INTO cs
          FROM handyman_visit_tenant_slot_consents c WHERE c.id=NEW.consent_id;
        IF NOT FOUND OR ap.warranty_rework_id IS NOT NULL OR ap.state<>'PROPOSED' OR ap.version<>NEW.appointment_version
          OR ap.kind IS DISTINCT FROM cs.kind OR ap.kind IS DISTINCT FROM NEW.kind
          OR ap.handyman_request_id IS DISTINCT FROM NEW.handyman_request_id
          OR ap.tenant_company_id IS DISTINCT FROM cs.tenant_company_id OR ap.building_id IS DISTINCT FROM cs.building_id
          OR ap.start_at IS DISTINCT FROM cs.selected_start_at OR ap.end_at IS DISTINCT FROM cs.selected_end_at THEN
          RAISE EXCEPTION 'Tenant slot binding does not match its PROPOSED appointment' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE OR REPLACE FUNCTION handyman_visit_consent_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE req RECORD;
      BEGIN
        SELECT r.client_id,r.tenant_company_id,r.building_id,r.tenant_pic_id INTO req
          FROM handyman_service_requests r WHERE r.id=NEW.handyman_request_id;
        IF NOT FOUND OR req.client_id IS DISTINCT FROM NEW.client_id OR req.tenant_company_id IS DISTINCT FROM NEW.tenant_company_id
          OR req.building_id IS DISTINCT FROM NEW.building_id OR req.tenant_pic_id IS DISTINCT FROM NEW.tenant_pic_id THEN
          RAISE EXCEPTION 'Tenant slot consent is not bound to the request tenant' USING ERRCODE='23514';
        END IF;
        IF EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_consents c WHERE c.handyman_request_id=NEW.handyman_request_id AND c.kind=NEW.kind
          AND NOT EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_bindings b WHERE b.consent_id=c.id)) THEN
          RAISE EXCEPTION 'A tenant slot choice is already pending for this visit kind' USING ERRCODE='23514';
        END IF;
        IF EXISTS (SELECT 1 FROM handyman_visit_appointments a WHERE a.handyman_request_id=NEW.handyman_request_id
          AND a.kind=NEW.kind AND a.warranty_rework_id IS NULL AND a.state IN ('TENANT_SELECTED','CONFIRMED','IN_PROGRESS')) THEN
          RAISE EXCEPTION 'A selected or confirmed visit already exists for this kind' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE OR REPLACE FUNCTION handyman_visit_consent_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state IN ('TENANT_SELECTED','CONFIRMED','IN_PROGRESS','COMPLETED') THEN
          IF NEW.warranty_rework_id IS NOT NULL THEN
            IF NOT EXISTS (SELECT 1 FROM handyman_warranty_rework_visit_consents c
              WHERE c.appointment_id=NEW.id AND c.id::text=NEW.tenant_choice_evidence_ref
                AND c.rework_id=NEW.warranty_rework_id AND c.execution_scope_id=NEW.execution_scope_id
                AND c.start_at=NEW.start_at AND c.end_at=NEW.end_at) THEN
              RAISE EXCEPTION 'Selected rework visit requires exact PIC consent.' USING ERRCODE='23514';
            END IF;
          ELSIF NOT EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_bindings b
            JOIN handyman_visit_tenant_slot_consents c ON c.id=b.consent_id
            WHERE b.appointment_id=NEW.id AND c.id::text=NEW.tenant_choice_evidence_ref) THEN
            RAISE EXCEPTION 'Selected visit requires its bound tenant slot consent' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NULL;
      END; $$;
    `);
    await tx.query(reworkDispatchMigrationGuardInstall);
  },
  async down(tx: PoolClient): Promise<void> {
    const used=await tx.query(`SELECT 1 FROM handyman_warranty_rework_executions LIMIT 1`);
    if (used.rowCount) throw new Error('Rework execution and visit history requires dispatch protection; downgrade refused.');
    await tx.query(reworkDispatchMigrationGuardRemove);
    // Restore the exact legacy guards before dropping the added columns.
    await tx.query(`
      CREATE OR REPLACE FUNCTION handyman_visit_consent_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state IN ('TENANT_SELECTED','CONFIRMED','IN_PROGRESS','COMPLETED') AND NOT EXISTS (
          SELECT 1 FROM handyman_visit_tenant_slot_bindings b JOIN handyman_visit_tenant_slot_consents c ON c.id=b.consent_id
          WHERE b.appointment_id=NEW.id AND c.id::text=NEW.tenant_choice_evidence_ref) THEN
          RAISE EXCEPTION 'Selected visit requires its bound tenant slot consent' USING ERRCODE='23514';
        END IF; RETURN NULL;
      END; $$;
      CREATE OR REPLACE FUNCTION handyman_visit_consent_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE req RECORD;
      BEGIN
        SELECT r.client_id,r.tenant_company_id,r.building_id,r.tenant_pic_id INTO req FROM handyman_service_requests r WHERE r.id=NEW.handyman_request_id;
        IF NOT FOUND OR req.client_id IS DISTINCT FROM NEW.client_id OR req.tenant_company_id IS DISTINCT FROM NEW.tenant_company_id
          OR req.building_id IS DISTINCT FROM NEW.building_id OR req.tenant_pic_id IS DISTINCT FROM NEW.tenant_pic_id THEN
          RAISE EXCEPTION 'Tenant slot consent is not bound to the request tenant' USING ERRCODE='23514'; END IF;
        IF EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_consents c WHERE c.handyman_request_id=NEW.handyman_request_id AND c.kind=NEW.kind
          AND NOT EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_bindings b WHERE b.consent_id=c.id)) THEN
          RAISE EXCEPTION 'A tenant slot choice is already pending for this visit kind' USING ERRCODE='23514'; END IF;
        IF EXISTS (SELECT 1 FROM handyman_visit_appointments a WHERE a.handyman_request_id=NEW.handyman_request_id AND a.kind=NEW.kind
          AND a.state IN ('TENANT_SELECTED','CONFIRMED','IN_PROGRESS')) THEN
          RAISE EXCEPTION 'A selected or confirmed visit already exists for this kind' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE OR REPLACE FUNCTION handyman_visit_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ap RECORD; cs RECORD;
      BEGIN
        SELECT a.state,a.version,a.kind,a.handyman_request_id,a.tenant_company_id,a.building_id,a.start_at,a.end_at INTO ap
          FROM handyman_visit_appointments a WHERE a.id=NEW.appointment_id;
        SELECT c.kind,c.tenant_company_id,c.building_id,c.selected_start_at,c.selected_end_at INTO cs
          FROM handyman_visit_tenant_slot_consents c WHERE c.id=NEW.consent_id;
        IF NOT FOUND OR ap.state<>'PROPOSED' OR ap.version<>NEW.appointment_version OR ap.kind IS DISTINCT FROM cs.kind
          OR ap.kind IS DISTINCT FROM NEW.kind OR ap.handyman_request_id IS DISTINCT FROM NEW.handyman_request_id
          OR ap.tenant_company_id IS DISTINCT FROM cs.tenant_company_id OR ap.building_id IS DISTINCT FROM cs.building_id
          OR ap.start_at IS DISTINCT FROM cs.selected_start_at OR ap.end_at IS DISTINCT FROM cs.selected_end_at THEN
          RAISE EXCEPTION 'Tenant slot binding does not match its PROPOSED appointment' USING ERRCODE='23514'; END IF; RETURN NEW;
      END; $$;
      DROP TRIGGER hm_rework_visit_bind ON handyman_visit_appointments;
      DROP TRIGGER hm_rework_visit_identity ON handyman_visit_appointments;
      DROP FUNCTION hm_rework_visit_bind(); DROP FUNCTION hm_rework_visit_identity();
      DROP TABLE handyman_warranty_rework_visit_consents;
      DROP FUNCTION hm_rework_visit_consent_guard();
      DROP FUNCTION hm_rework_visit_assignment_current(UUID);
      DROP TABLE handyman_warranty_rework_visit_bindings;
      DROP FUNCTION hm_rework_visit_operations(UUID,UUID); DROP FUNCTION hm_rework_visit_immutable();
      DROP INDEX hm_rework_visit_one_live; DROP INDEX hm_rework_visit_key; DROP INDEX hm_rework_visit_supersedes;
      DROP INDEX handyman_visit_appointments_one_live_per_request_kind;
      ALTER TABLE handyman_visit_appointments DROP COLUMN warranty_rework_id, DROP COLUMN warranty_rework_key;
      CREATE UNIQUE INDEX handyman_visit_appointments_one_live_per_request_kind
        ON handyman_visit_appointments(handyman_request_id,kind)
        WHERE state IN ('PROPOSED','TENANT_SELECTED','CONFIRMED','IN_PROGRESS');
    `);
  },
};
