import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Item-level work evidence, separate from the frozen work-session clock and
 * helper presence. No prices, rates, charges or implied manpower are stored. */
export const migration0512HandymanAddLaborExecution: Migration = {
  id: '0512_handyman_add_labor_execution',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_add_labor_executions (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        variation_id UUID NOT NULL REFERENCES handyman_scope_variations(id),
        approved_variation_version INTEGER NOT NULL CHECK (approved_variation_version > 0),
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        quotation_line_id UUID NOT NULL REFERENCES handyman_quotation_lines(id),
        work_order_id UUID NOT NULL REFERENCES work_orders(id),
        work_session_id UUID NOT NULL REFERENCES handyman_work_sessions(id),
        assignment_id UUID NOT NULL REFERENCES handyman_execution_scope_assignments(id),
        lead_worker_id UUID NOT NULL REFERENCES handyman_worker_contexts(id),
        lead_user_id UUID NOT NULL REFERENCES users(id),
        uom_id UUID NOT NULL REFERENCES units_of_measure(id),
        approved_qty NUMERIC(14,3) NOT NULL CHECK (approved_qty > 0),
        actual_qty NUMERIC(14,3) NOT NULL CHECK (actual_qty > 0 AND actual_qty <= approved_qty),
        evidence_id UUID NOT NULL REFERENCES handyman_field_evidence_uploads(id),
        evidence_reference TEXT NOT NULL,
        evidence_sha256 VARCHAR(64) NOT NULL CHECK (char_length(evidence_sha256) = 64),
        idempotency_key VARCHAR(128) NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT hm_add_labor_one_record_per_session UNIQUE (variation_id, work_session_id),
        CONSTRAINT hm_add_labor_idempotency UNIQUE (variation_id, idempotency_key),
        CONSTRAINT hm_add_labor_evidence_once UNIQUE (evidence_id)
      );
      CREATE INDEX hm_add_labor_scope_idx ON handyman_add_labor_executions(execution_scope_id, recorded_at, id);

      CREATE FUNCTION hm_add_labor_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous_qty NUMERIC;
      BEGIN
        -- Matches authorization, assignment and work-session lock order.
        PERFORM 1 FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id FOR UPDATE;
        -- Crew lead designation takes an exclusive lock on this same crew row.
        PERFORM 1 FROM handyman_work_crews c
          JOIN handyman_execution_scope_assignments a ON a.handyman_crew_id=c.id
          WHERE a.id=NEW.assignment_id FOR SHARE OF c;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_scope_variations v
          JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id
            AND s.client_id=v.client_id AND s.handyman_request_id=v.handyman_request_id
            AND s.building_id=v.building_id AND s.tenant_company_id=v.tenant_company_id
          JOIN handyman_quotation_versions qv ON qv.id=v.revised_quotation_version_id
            AND qv.quotation_id=s.quotation_id
          JOIN handyman_quotation_lines ql ON ql.id=NEW.quotation_line_id AND ql.quotation_version_id=qv.id
          JOIN work_orders wo ON wo.id=NEW.work_order_id AND wo.client_id=s.client_id AND wo.building_id=s.building_id
          JOIN handyman_work_sessions ws ON ws.id=NEW.work_session_id AND ws.execution_scope_id=s.id
            AND ws.client_id=s.client_id AND ws.status='IN_PROGRESS' AND ws.started_work_at IS NOT NULL
          JOIN handyman_execution_scope_assignments a ON a.id=ws.assignment_id AND a.status='ACTIVE'
            AND a.execution_scope_id=s.id AND a.client_id=s.client_id
          JOIN handyman_crew_leads cl ON cl.handyman_crew_id=a.handyman_crew_id
            AND cl.lead_seq=(SELECT MAX(cl2.lead_seq) FROM handyman_crew_leads cl2 WHERE cl2.handyman_crew_id=a.handyman_crew_id)
          JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id
            AND cm.status='ACTIVE' AND cm.handyman_worker_context_id=ws.lead_worker_id
          JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id
          JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id AND wp.user_id=ws.lead_user_id
          JOIN handyman_field_evidence_uploads e ON e.id=NEW.evidence_id AND e.client_id=s.client_id
            AND e.building_id=s.building_id AND e.handyman_request_id=s.handyman_request_id
            AND e.execution_scope_id=s.id AND (e.variation_id IS NULL OR e.variation_id=v.id)
          JOIN handyman_scope_variation_events r ON r.variation_id=v.id AND r.execution_scope_id=s.id
            AND r.event_type='REVISED_QUOTATION' AND r.actor_role='OPERATIONS_MANAGER'
          JOIN handyman_scope_variation_events d ON d.variation_id=v.id AND d.execution_scope_id=s.id
            AND d.event_type='TENANT_DECISION' AND d.actor_role='TENANT' AND d.actor_user_id=v.tenant_decided_by_user_id
          JOIN handyman_scope_variation_events auth ON auth.variation_id=v.id AND auth.execution_scope_id=s.id
            AND auth.event_type='AUTHORIZED_SCOPE' AND auth.actor_role='OPERATIONS_MANAGER'
          WHERE v.id=NEW.variation_id AND s.id=NEW.execution_scope_id AND s.client_id=NEW.client_id
            AND s.status='AUTHORIZED' AND v.variation_type='ADD' AND v.line_type='LABOR'
            AND v.tenant_decision_outcome='APPROVED' AND v.status IN ('AUTHORIZED_SCOPE','EXECUTION')
            AND NEW.quotation_version_id=qv.id AND qv.id<>s.approved_quotation_version_id
            AND ql.line_type='LABOR' AND ql.quantity=v.quantity AND ql.uom_id=v.uom_id
            AND ql.final_quoted_unit_amount=v.quoted_unit_amount AND ql.currency=v.currency
            AND NEW.approved_qty=v.quantity AND NEW.uom_id=v.uom_id
            AND NEW.assignment_id=ws.assignment_id AND NEW.lead_worker_id=ws.lead_worker_id
            AND NEW.lead_user_id=ws.lead_user_id AND wo.status IN ('OPEN','ASSIGNED','IN_PROGRESS')
            AND e.purpose='BEFORE_AFTER_WORK' AND e.upload_status='VERIFIED' AND e.verified_byte_size>0
            AND e.attachment_reference=NEW.evidence_reference AND e.sha256_checksum=NEW.evidence_sha256
            AND e.verified_at>=ws.started_work_at
            AND r.metadata->>'revisedQuotationVersionId'=qv.id::text
            AND r.metadata->>'revisedQuotationLineId'=ql.id::text AND r.metadata->>'workOrderId'=wo.id::text
            AND d.metadata->>'decisionOutcome'='APPROVED'
            AND d.metadata->'consentSnapshot'->>'version'=NEW.approved_variation_version::text
            AND d.metadata->'consentSnapshot'->>'revisedQuotationVersionId'=qv.id::text
            AND d.metadata->'consentSnapshot'->>'revisedQuotationLineId'=ql.id::text
            AND d.metadata->'consentSnapshot'->>'workOrderId'=wo.id::text
            AND d.metadata->'consentSnapshot'->>'quantity'=v.quantity::text
            AND d.metadata->'consentSnapshot'->>'uomId'=v.uom_id::text
        ) THEN
          RAISE EXCEPTION 'ADD labor requires the exact approved line, Work Order, active Lead session and verified work evidence'
            USING ERRCODE='23514';
        END IF;
        SELECT COALESCE(SUM(actual_qty),0) INTO previous_qty
          FROM handyman_add_labor_executions WHERE variation_id=NEW.variation_id;
        IF previous_qty + NEW.actual_qty > NEW.approved_qty THEN
          RAISE EXCEPTION 'ADD labor quantity exceeds approved variation' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hm_add_labor_execution_guard_trg BEFORE INSERT ON handyman_add_labor_executions
        FOR EACH ROW EXECUTE FUNCTION hm_add_labor_execution_guard();

      CREATE FUNCTION hm_add_labor_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ADD labor execution is append-only';
      END;
      $$;
      CREATE TRIGGER hm_add_labor_execution_immutable_trg BEFORE UPDATE OR DELETE ON handyman_add_labor_executions
        FOR EACH ROW EXECUTE FUNCTION hm_add_labor_execution_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_add_labor_executions) THEN
          RAISE EXCEPTION 'Cannot remove ADD labor execution while history exists';
        END IF;
      END $$;
      DROP TRIGGER hm_add_labor_execution_immutable_trg ON handyman_add_labor_executions;
      DROP FUNCTION hm_add_labor_execution_immutable();
      DROP TRIGGER hm_add_labor_execution_guard_trg ON handyman_add_labor_executions;
      DROP FUNCTION hm_add_labor_execution_guard();
      DROP TABLE handyman_add_labor_executions;
    `);
  },
};
