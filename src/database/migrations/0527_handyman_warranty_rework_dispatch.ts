import type { PoolClient } from 'pg';
import type { Migration } from './types';
import { reworkDispatchMigrationGuardInstall, reworkDispatchMigrationGuardRemove } from './0526_handyman_warranty_rework_appointments';

/** Prospective guard only: legacy visits/releases remain unchanged and cannot authorize rework. */
export const migration0527HandymanWarrantyReworkDispatch: Migration = {
  id: '0527_handyman_warranty_rework_dispatch',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE FUNCTION hm_rework_dispatch_visit_current(scope_uuid UUID,visit_uuid UUID,assignment_uuid UUID)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id AND s.scope_kind='WARRANTY_REWORK'
            AND s.warranty_rework_id=x.rework_id AND s.client_id=x.client_id AND s.building_id=x.building_id
            AND s.status='AUTHORIZED'
          JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id AND r.claim_id=x.claim_id
            AND r.status IN ('REWORK_AUTHORIZED','REWORK_IN_PROGRESS')
          JOIN handyman_visit_appointments v ON v.id=visit_uuid AND v.execution_scope_id=s.id
            AND v.warranty_rework_id=x.rework_id AND v.client_id=x.client_id AND v.building_id=x.building_id
            AND v.handyman_request_id=s.handyman_request_id AND v.tenant_company_id=s.tenant_company_id
            AND v.kind='EXECUTION' AND v.resource_type='CREW' AND v.state IN ('CONFIRMED','IN_PROGRESS')
          JOIN handyman_warranty_rework_visit_bindings b ON b.appointment_id=v.id AND b.rework_id=x.rework_id
            AND b.execution_scope_id=x.execution_scope_id AND b.claim_id=x.claim_id AND b.assessment_id=x.assessment_id
            AND b.certificate_id=x.certificate_id AND b.item_line_id=x.item_line_id
            AND b.client_id=x.client_id AND b.building_id=x.building_id AND b.assignment_id=assignment_uuid
            AND b.crew_id=v.resource_id
          JOIN handyman_warranty_rework_visit_consents c ON c.appointment_id=v.id
            AND c.id::text=v.tenant_choice_evidence_ref AND c.rework_id=x.rework_id
            AND c.execution_scope_id=s.id AND c.claim_id=x.claim_id AND c.assessment_id=x.assessment_id
            AND c.client_id=x.client_id AND c.building_id=x.building_id AND c.tenant_pic_id=s.tenant_pic_id
            AND c.start_at=v.start_at AND c.end_at=v.end_at
            AND v.version=c.appointment_version + CASE v.state WHEN 'CONFIRMED' THEN 2 ELSE 3 END
          JOIN user_sessions sess ON sess.id=c.tenant_session_id AND sess.user_id=c.tenant_user_id
          JOIN handyman_execution_scope_assignments a ON a.id=b.assignment_id AND a.execution_scope_id=s.id
            AND a.client_id=x.client_id AND a.status='ACTIVE' AND a.handyman_crew_id=b.crew_id
          JOIN handyman_work_crews crew ON crew.id=a.handyman_crew_id AND crew.status='ACTIVE'
            AND crew.client_id=x.client_id AND crew.handyman_provider_context_id=a.handyman_provider_context_id
          JOIN handyman_provider_contexts pc ON pc.id=a.handyman_provider_context_id AND pc.status='ACTIVE' AND pc.client_id=x.client_id
          JOIN handyman_crew_leads cl ON cl.handyman_crew_id=crew.id
            AND cl.lead_seq=(SELECT max(l.lead_seq) FROM handyman_crew_leads l WHERE l.handyman_crew_id=crew.id)
          JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id AND cm.status='ACTIVE'
          JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id AND wc.status='ACTIVE'
          JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id AND wp.status='ACTIVE' AND wp.user_id=b.lead_user_id
          JOIN users u ON u.id=wp.user_id AND u.status='ACTIVE'
          JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.building_id=x.building_id AND uba.status='ACTIVE'
          JOIN handyman_visit_capacity_reservations cap ON cap.appointment_id=v.id AND cap.active
            AND cap.client_id=x.client_id AND cap.resource_type='CREW' AND cap.resource_id=v.resource_id
            AND cap.start_at=v.start_at AND cap.end_at=v.end_at
          WHERE x.execution_scope_id=scope_uuid AND hm_warranty_rework_scope_current(scope_uuid)
            AND NOT EXISTS (SELECT 1 FROM handyman_assignment_responses resp
              WHERE resp.assignment_id=a.id AND resp.response_status='TIDAK_BISA')
            AND NOT EXISTS (SELECT 1 FROM handyman_customer_transactions t WHERE t.execution_scope_id=s.id))
      $$;

      CREATE FUNCTION hm_rework_dispatch_local_ready(scope_uuid UUID,visit_uuid UUID)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
          JOIN handyman_visit_appointments v ON v.id=visit_uuid AND v.execution_scope_id=s.id
            AND v.end_at>clock_timestamp()
          JOIN handyman_permit_readiness p ON p.handyman_request_id=s.handyman_request_id AND p.client_id=x.client_id
            AND p.building_id=x.building_id AND p.space_id IS NOT DISTINCT FROM s.space_id AND p.status='ACTIVE'
            AND p.valid_from<=v.start_at AND p.valid_until>=v.end_at
          JOIN handyman_unit_access_readiness ua ON ua.handyman_request_id=s.handyman_request_id AND ua.client_id=x.client_id
            AND ua.building_id=x.building_id AND ua.space_id IS NOT DISTINCT FROM s.space_id AND ua.status='ACTIVE'
            AND ua.access_window_start<=v.start_at AND ua.access_window_end>=v.end_at
          WHERE x.execution_scope_id=scope_uuid)
      $$;

      CREATE FUNCTION hm_rework_dispatch_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' AND NEW.status<>'RELEASED' AND EXISTS
          (SELECT 1 FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id) THEN
          RAISE EXCEPTION 'Rework dispatch must be created RELEASED by Operations.' USING ERRCODE='23514';
        END IF;
        IF EXISTS (SELECT 1 FROM handyman_warranty_rework_executions WHERE execution_scope_id=NEW.execution_scope_id)
          AND NEW.status IN ('RELEASED','IN_PROGRESS') AND (
            NOT hm_rework_dispatch_visit_current(NEW.execution_scope_id,NEW.appointment_id,NEW.assignment_id) OR
            NOT hm_rework_dispatch_local_ready(NEW.execution_scope_id,NEW.appointment_id) OR
            (NEW.status='IN_PROGRESS' AND NOT EXISTS (SELECT 1 FROM handyman_visit_appointments v
              WHERE v.id=NEW.appointment_id AND v.start_at<=clock_timestamp() AND v.end_at>clock_timestamp())) OR
            (TG_OP='INSERT' AND NOT hm_rework_visit_operations(NEW.execution_scope_id,NEW.released_by_user_id))) THEN
          RAISE EXCEPTION 'Rework dispatch requires its current covered claim, exact consented visit, assigned Lead and permit/access.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_rework_dispatch_release BEFORE INSERT OR UPDATE ON handyman_dispatch_releases
        FOR EACH ROW EXECUTE FUNCTION hm_rework_dispatch_release_guard();

      CREATE FUNCTION hm_rework_session_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP='INSERT' OR (NEW.status='IN_PROGRESS' AND OLD.status IS DISTINCT FROM NEW.status))
          AND EXISTS (SELECT 1 FROM handyman_execution_scopes s WHERE s.id=NEW.execution_scope_id AND s.scope_kind='WARRANTY_REWORK')
          AND NOT EXISTS (
            SELECT 1 FROM handyman_warranty_rework_executions x
            JOIN handyman_service_warranty_reworks r ON r.id=x.rework_id AND r.status='REWORK_IN_PROGRESS'
            JOIN handyman_dispatch_releases dr ON dr.execution_scope_id=x.execution_scope_id
              AND dr.client_id=x.client_id AND dr.assignment_id=NEW.assignment_id AND dr.status IN ('RELEASED','IN_PROGRESS')
            JOIN handyman_visit_appointments v ON v.id=dr.appointment_id AND v.start_at<=clock_timestamp() AND v.end_at>clock_timestamp()
            JOIN handyman_warranty_rework_visit_bindings b ON b.appointment_id=v.id AND b.lead_user_id=NEW.lead_user_id
            JOIN handyman_execution_scope_assignments a ON a.id=dr.assignment_id
            JOIN LATERAL (SELECT ar.* FROM handyman_arrival_verification_results ar
              WHERE ar.execution_scope_id=x.execution_scope_id AND ar.assignment_id=dr.assignment_id AND ar.actor_user_id=b.lead_user_id
              ORDER BY ar.evaluated_at DESC,ar.id DESC LIMIT 1) ar
              ON ar.expected_building_id=x.building_id AND ar.status='VERIFIED' AND ar.evaluated_at>=a.assigned_at
            WHERE x.execution_scope_id=NEW.execution_scope_id AND NEW.client_id=x.client_id
              AND hm_rework_dispatch_visit_current(x.execution_scope_id,v.id,dr.assignment_id)
              AND hm_rework_dispatch_local_ready(x.execution_scope_id,v.id)
          ) THEN RAISE EXCEPTION 'Rework session requires its current consented dispatch and permit/access.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_rework_session_dispatch BEFORE INSERT OR UPDATE ON handyman_work_sessions
        FOR EACH ROW EXECUTE FUNCTION hm_rework_session_dispatch_guard();

      CREATE FUNCTION hm_rework_start_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status='REWORK_AUTHORIZED' AND NEW.status='REWORK_IN_PROGRESS' AND NOT EXISTS (
          SELECT 1 FROM handyman_warranty_rework_executions x
          JOIN handyman_execution_scopes s ON s.id=x.execution_scope_id
          JOIN handyman_dispatch_releases dr ON dr.execution_scope_id=s.id AND dr.client_id=x.client_id
            AND dr.status IN ('RELEASED','IN_PROGRESS')
          JOIN handyman_visit_appointments v ON v.id=dr.appointment_id AND v.start_at<=clock_timestamp() AND v.end_at>clock_timestamp()
          JOIN handyman_warranty_rework_visit_bindings b ON b.appointment_id=v.id AND b.assignment_id=dr.assignment_id
          JOIN handyman_execution_scope_assignments a ON a.id=dr.assignment_id
          JOIN LATERAL (SELECT ar.* FROM handyman_arrival_verification_results ar
            WHERE ar.execution_scope_id=s.id AND ar.assignment_id=dr.assignment_id AND ar.actor_user_id=b.lead_user_id
            ORDER BY ar.evaluated_at DESC,ar.id DESC LIMIT 1) ar
            ON ar.expected_building_id=x.building_id AND ar.status='VERIFIED' AND ar.evaluated_at>=a.assigned_at
          JOIN handyman_permit_readiness p ON p.handyman_request_id=s.handyman_request_id AND p.client_id=x.client_id
            AND p.building_id=x.building_id AND p.space_id IS NOT DISTINCT FROM s.space_id AND p.status='ACTIVE'
            AND p.valid_from<=v.start_at AND p.valid_until>=v.end_at
          JOIN handyman_unit_access_readiness ua ON ua.handyman_request_id=s.handyman_request_id AND ua.client_id=x.client_id
            AND ua.building_id=x.building_id AND ua.space_id IS NOT DISTINCT FROM s.space_id AND ua.status='ACTIVE'
            AND ua.access_window_start<=v.start_at AND ua.access_window_end>=v.end_at
          WHERE x.rework_id=NEW.id AND hm_rework_dispatch_visit_current(s.id,v.id,dr.assignment_id)
        ) THEN RAISE EXCEPTION 'Rework start requires the current consented dispatch and BM permit/access.' USING ERRCODE='23514'; END IF;
        IF OLD.status='REWORK_IN_PROGRESS' AND NEW.status='REWORK_COMPLETE' AND NOT EXISTS (
          SELECT 1 FROM handyman_warranty_rework_executions x JOIN handyman_dispatch_releases dr
            ON dr.execution_scope_id=x.execution_scope_id AND dr.client_id=x.client_id
            AND dr.status IN ('RELEASED','IN_PROGRESS','COMPLETED')
          WHERE x.rework_id=NEW.id AND hm_rework_dispatch_visit_current(x.execution_scope_id,dr.appointment_id,dr.assignment_id)
        ) THEN RAISE EXCEPTION 'Rework completion requires its consented dispatch.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_rework_start_dispatch BEFORE UPDATE ON handyman_service_warranty_reworks
        FOR EACH ROW EXECUTE FUNCTION hm_rework_start_dispatch_guard();
    `);
    await tx.query(reworkDispatchMigrationGuardRemove);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(reworkDispatchMigrationGuardInstall);
    await tx.query(`DROP TRIGGER hm_rework_start_dispatch ON handyman_service_warranty_reworks;
      DROP FUNCTION hm_rework_start_dispatch_guard();
      DROP TRIGGER hm_rework_session_dispatch ON handyman_work_sessions;
      DROP FUNCTION hm_rework_session_dispatch_guard();
      DROP TRIGGER hm_rework_dispatch_release ON handyman_dispatch_releases;
      DROP FUNCTION hm_rework_dispatch_release_guard();
      DROP FUNCTION hm_rework_dispatch_local_ready(UUID,UUID);
      DROP FUNCTION hm_rework_dispatch_visit_current(UUID,UUID,UUID);`);
  },
};
