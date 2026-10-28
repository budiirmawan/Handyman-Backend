import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A resolution is an explicit fact, separate from the immutable claim decision. */
export const migration0529HandymanWarrantyClaimResolution: Migration = {
  id: '0529_handyman_warranty_claim_resolution',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_warranty_resolution_proposals (
        id UUID PRIMARY KEY,
        claim_id UUID NOT NULL REFERENCES handyman_service_warranty_claims(id),
        rework_id UUID NOT NULL REFERENCES handyman_service_warranty_reworks(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_warranty_rework_executions(execution_scope_id),
        completion_id UUID NOT NULL REFERENCES handyman_warranty_rework_completions(id),
        assessment_id UUID NOT NULL REFERENCES handyman_warranty_claim_assessments(id),
        certificate_id UUID NOT NULL REFERENCES handyman_warranty_certificates(id),
        qc_run_id UUID NOT NULL REFERENCES handyman_qc_runs(id),
        qc_run_version INTEGER NOT NULL CHECK (qc_run_version>0),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        tenant_pic_id UUID NOT NULL REFERENCES tenant_pics(id),
        proposed_by_user_id UUID NOT NULL REFERENCES users(id),
        proposed_session_id UUID NOT NULL REFERENCES user_sessions(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(id,claim_id), UNIQUE(claim_id,qc_run_id), UNIQUE(claim_id,idempotency_key)
      );
      CREATE TABLE handyman_warranty_resolution_events (
        id UUID PRIMARY KEY,
        proposal_id UUID NOT NULL,
        claim_id UUID NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('ACKNOWLEDGED','DISPUTED','RESOLVED')),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        actor_session_id UUID NOT NULL REFERENCES user_sessions(id),
        note TEXT CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (proposal_id,claim_id) REFERENCES handyman_warranty_resolution_proposals(id,claim_id),
        UNIQUE(proposal_id,event_type,idempotency_key),
        CHECK (event_type='DISPUTED' OR note IS NULL)
      );
      CREATE UNIQUE INDEX hm_resolution_one_tenant_response ON handyman_warranty_resolution_events(proposal_id)
        WHERE event_type IN ('ACKNOWLEDGED','DISPUTED');
      CREATE UNIQUE INDEX hm_resolution_one_final ON handyman_warranty_resolution_events(claim_id) WHERE event_type='RESOLVED';
      CREATE INDEX hm_resolution_events_claim ON handyman_warranty_resolution_events(claim_id,occurred_at,id);

      -- Structural provenance only. The service also invokes the existing QC
      -- gate, which verifies actual managed evidence bytes at every action.
      CREATE FUNCTION hm_warranty_resolution_basis_current(p handyman_warranty_resolution_proposals)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_service_warranty_claims cl ON cl.id=x.claim_id AND cl.status='CLAIM_APPROVED'
            AND cl.client_id=x.client_id AND cl.execution_scope_id=x.original_scope_id AND cl.decision_assessment_id=x.assessment_id
          JOIN handyman_warranty_claim_bindings cb ON cb.claim_id=cl.id AND cb.certificate_id=x.certificate_id
            AND cb.item_line_id=x.item_line_id AND cb.coverage_kind=x.coverage_kind
          JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id AND r.claim_id=cl.id AND r.status='REWORK_COMPLETE'
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id AND s.scope_kind='WARRANTY_REWORK'
            AND s.warranty_rework_id=r.id AND s.client_id=x.client_id AND s.building_id=x.building_id
            AND s.tenant_pic_id=p.tenant_pic_id
          JOIN handyman_warranty_rework_completions c ON c.id=p.completion_id AND c.rework_id=r.id AND c.execution_scope_id=s.id
          JOIN handyman_warranty_rework_qc_bindings qb ON qb.completion_id=c.id AND qb.execution_scope_id=s.id AND qb.qc_run_id=p.qc_run_id
          JOIN handyman_qc_runs q ON q.id=qb.qc_run_id AND q.client_id=x.client_id AND q.execution_scope_id=s.id
            AND q.status='PASSED' AND q.version=p.qc_run_version AND q.created_at>=c.completed_at
          JOIN handyman_dispatch_releases d ON d.execution_scope_id=s.id AND d.client_id=x.client_id
            AND d.assignment_id=c.assignment_id AND d.released_at<=c.completed_at
            AND (d.cancelled_at IS NULL OR d.cancelled_at>=c.completed_at)
          JOIN handyman_visit_appointments v ON v.id=d.appointment_id AND v.execution_scope_id=s.id
            AND v.warranty_rework_id=r.id AND v.kind='EXECUTION' AND v.resource_type='CREW'
            AND v.client_id=x.client_id AND v.building_id=x.building_id AND v.handyman_request_id=s.handyman_request_id
            AND v.tenant_company_id=s.tenant_company_id AND v.confirmed_at IS NOT NULL AND v.confirmed_at<=d.released_at
          JOIN handyman_warranty_rework_visit_bindings vb ON vb.appointment_id=v.id AND vb.rework_id=r.id
            AND vb.execution_scope_id=s.id AND vb.claim_id=cl.id AND vb.assessment_id=x.assessment_id
            AND vb.certificate_id=x.certificate_id AND vb.item_line_id=x.item_line_id AND vb.client_id=x.client_id
            AND vb.building_id=x.building_id AND vb.assignment_id=c.assignment_id AND vb.lead_user_id=c.lead_user_id
            AND vb.crew_id=v.resource_id
          JOIN handyman_warranty_rework_visit_consents vc ON vc.appointment_id=v.id AND vc.id::text=v.tenant_choice_evidence_ref
            AND vc.rework_id=r.id AND vc.execution_scope_id=s.id AND vc.claim_id=cl.id AND vc.assessment_id=x.assessment_id
            AND vc.client_id=x.client_id AND vc.building_id=x.building_id AND vc.tenant_pic_id=s.tenant_pic_id
            AND vc.start_at=v.start_at AND vc.end_at=v.end_at AND vc.accepted_at<=v.confirmed_at
          JOIN user_sessions tenant_session ON tenant_session.id=vc.tenant_session_id AND tenant_session.user_id=vc.tenant_user_id
          WHERE x.claim_id=p.claim_id AND x.rework_id=p.rework_id AND x.execution_scope_id=p.execution_scope_id
            AND x.assessment_id=p.assessment_id AND x.certificate_id=p.certificate_id
            AND x.client_id=p.client_id AND x.building_id=p.building_id
            AND hm_warranty_rework_scope_current(s.id)
            AND ((v.state='CONFIRMED' AND v.version=vc.appointment_version+2)
              OR (v.state='IN_PROGRESS' AND v.version=vc.appointment_version+3)
              OR (v.state='COMPLETED' AND v.version=vc.appointment_version+4)
              OR (v.state='CANCELLED' AND v.version IN (vc.appointment_version+3,vc.appointment_version+4)))
            AND NOT EXISTS (SELECT 1 FROM handyman_qc_runs newer WHERE newer.execution_scope_id=s.id
              AND (newer.created_at,newer.id)>(q.created_at,q.id))
            AND EXISTS (SELECT 1 FROM handyman_qc_run_events e WHERE e.run_id=q.id AND e.client_id=q.client_id
              AND e.event_type='FINISH' AND e.metadata->>'outcome'='PASSED')
        )
      $$;
      CREATE FUNCTION hm_warranty_resolution_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent UUID;
      BEGIN
        SELECT original_scope_id INTO parent FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id;
        PERFORM id FROM handyman_execution_scopes WHERE id=parent FOR SHARE;
        PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM user_sessions sess JOIN users u ON u.id=sess.user_id AND u.status='ACTIVE'
          WHERE sess.id=NEW.proposed_session_id AND sess.user_id=NEW.proposed_by_user_id
            AND sess.status='ACTIVE' AND sess.expires_at>clock_timestamp())
          OR NOT hm_rework_visit_operations(NEW.execution_scope_id,NEW.proposed_by_user_id)
          OR EXISTS (SELECT 1 FROM handyman_warranty_resolution_events e WHERE e.claim_id=NEW.claim_id AND e.event_type='RESOLVED')
          OR NOT hm_warranty_resolution_basis_current(NEW)
        THEN RAISE EXCEPTION 'Resolution proposal requires authorized Operations and the exact current completed rework and fresh QC PASS.' USING ERRCODE='23514'; END IF;
        NEW.proposed_at:=statement_timestamp(); RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_resolution_proposal_insert BEFORE INSERT ON handyman_warranty_resolution_proposals
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_resolution_proposal_guard();
      CREATE FUNCTION hm_warranty_resolution_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE p handyman_warranty_resolution_proposals%ROWTYPE; parent UUID;
      BEGIN
        SELECT * INTO p FROM handyman_warranty_resolution_proposals WHERE id=NEW.proposal_id AND claim_id=NEW.claim_id;
        IF p.id IS NULL THEN RAISE EXCEPTION 'Resolution proposal not found.' USING ERRCODE='23514'; END IF;
        SELECT original_scope_id INTO parent FROM handyman_warranty_rework_executions WHERE execution_scope_id=p.execution_scope_id;
        PERFORM id FROM handyman_execution_scopes WHERE id=parent FOR SHARE;
        PERFORM id FROM handyman_execution_scopes WHERE id=p.execution_scope_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM user_sessions sess JOIN users u ON u.id=sess.user_id AND u.status='ACTIVE'
          WHERE sess.id=NEW.actor_session_id AND sess.user_id=NEW.actor_user_id
            AND sess.status='ACTIVE' AND sess.expires_at>clock_timestamp())
          OR EXISTS (SELECT 1 FROM handyman_warranty_resolution_events e WHERE e.claim_id=p.claim_id AND e.event_type='RESOLVED')
          OR NOT hm_warranty_resolution_basis_current(p)
        THEN RAISE EXCEPTION 'Resolution event requires a live session and exact current rework/QC basis.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type IN ('ACKNOWLEDGED','DISPUTED') THEN
          IF NOT EXISTS (SELECT 1 FROM handyman_execution_scopes s JOIN tenant_pics pic
              ON pic.id=s.tenant_pic_id AND pic.tenant_company_id=s.tenant_company_id AND pic.status='ACTIVE'
              AND pic.user_id=NEW.actor_user_id
            JOIN user_building_assignments a ON a.user_id=pic.user_id AND a.building_id=s.building_id AND a.status='ACTIVE'
            JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
            JOIN properties pr ON pr.id=b.property_id AND pr.client_id=s.client_id
            WHERE s.id=p.execution_scope_id AND pic.id=p.tenant_pic_id)
          THEN RAISE EXCEPTION 'Only the authenticated exact request Tenant PIC may acknowledge or dispute.' USING ERRCODE='23514'; END IF;
        ELSIF NEW.event_type='RESOLVED' THEN
          IF NOT hm_rework_visit_operations(p.execution_scope_id,NEW.actor_user_id) OR NOT EXISTS (
            SELECT 1 FROM handyman_warranty_resolution_events ack JOIN user_sessions sess
              ON sess.id=ack.actor_session_id AND sess.user_id=ack.actor_user_id
            JOIN tenant_pics pic ON pic.id=p.tenant_pic_id AND pic.user_id=ack.actor_user_id
            WHERE ack.proposal_id=p.id AND ack.claim_id=p.claim_id AND ack.event_type='ACKNOWLEDGED')
          THEN RAISE EXCEPTION 'Resolution requires Operations and the exact Tenant PIC acknowledgment.' USING ERRCODE='23514'; END IF;
        END IF;
        NEW.occurred_at:=statement_timestamp(); RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_resolution_event_insert BEFORE INSERT ON handyman_warranty_resolution_events
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_resolution_event_guard();
      CREATE FUNCTION hm_warranty_resolution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Warranty resolution facts are immutable.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_resolution_proposal_immutable BEFORE UPDATE OR DELETE ON handyman_warranty_resolution_proposals
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_resolution_immutable();
      CREATE TRIGGER hm_resolution_event_immutable BEFORE UPDATE OR DELETE ON handyman_warranty_resolution_events
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_resolution_immutable();
      CREATE TRIGGER hm_resolution_proposal_no_truncate BEFORE TRUNCATE ON handyman_warranty_resolution_proposals
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_resolution_immutable();
      CREATE TRIGGER hm_resolution_event_no_truncate BEFORE TRUNCATE ON handyman_warranty_resolution_events
        FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_resolution_immutable();
      -- QC opening and finalization serialize on the same original -> child
      -- scope locks, so an accepted final result cannot be silently superseded.
      CREATE FUNCTION hm_warranty_resolution_qc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent UUID; claim_uuid UUID;
      BEGIN
        SELECT original_scope_id,claim_id INTO parent,claim_uuid FROM handyman_warranty_rework_executions
          WHERE execution_scope_id=NEW.execution_scope_id;
        IF claim_uuid IS NOT NULL THEN
          PERFORM id FROM handyman_execution_scopes WHERE id=parent FOR SHARE;
          PERFORM id FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
          IF EXISTS (SELECT 1 FROM handyman_warranty_resolution_events WHERE claim_id=claim_uuid AND event_type='RESOLVED') THEN
            RAISE EXCEPTION 'A resolved warranty claim cannot open another rework QC run.' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_resolution_qc_guard BEFORE INSERT ON handyman_qc_runs FOR EACH ROW EXECUTE FUNCTION hm_warranty_resolution_qc_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM handyman_warranty_resolution_proposals) THEN
        RAISE EXCEPTION 'Cannot discard warranty claim resolution history.'; END IF; END $$;
      DROP TRIGGER hm_resolution_qc_guard ON handyman_qc_runs;
      DROP TRIGGER hm_resolution_event_insert ON handyman_warranty_resolution_events;
      DROP TRIGGER hm_resolution_event_immutable ON handyman_warranty_resolution_events;
      DROP TRIGGER hm_resolution_event_no_truncate ON handyman_warranty_resolution_events;
      DROP TRIGGER hm_resolution_proposal_insert ON handyman_warranty_resolution_proposals;
      DROP TRIGGER hm_resolution_proposal_immutable ON handyman_warranty_resolution_proposals;
      DROP TRIGGER hm_resolution_proposal_no_truncate ON handyman_warranty_resolution_proposals;
      DROP FUNCTION hm_warranty_resolution_qc_guard(),hm_warranty_resolution_event_guard(),
        hm_warranty_resolution_proposal_guard(),hm_warranty_resolution_immutable(),
        hm_warranty_resolution_basis_current(handyman_warranty_resolution_proposals);
      DROP TABLE handyman_warranty_resolution_events,handyman_warranty_resolution_proposals;
    `);
  },
};
