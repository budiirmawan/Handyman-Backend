import type { Migration } from './types';

/** Physical attempts extend 0381; report corrections remain 0446 versions. */
export const migration0450HandymanInspectionRevisits: Migration = {
  id: '0450_handyman_inspection_revisits',
  async up(client) {
    await client.query(`
      CREATE TABLE handyman_inspection_revisit_attempts (
        id UUID PRIMARY KEY,
        handyman_request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        attempt_number INTEGER NOT NULL CHECK(attempt_number > 1),
        preceding_inspection_id UUID NOT NULL UNIQUE REFERENCES handyman_request_inspections(id),
        preceding_report_id UUID NOT NULL UNIQUE REFERENCES handyman_request_inspection_reports(id),
        inspection_assignment_id UUID NOT NULL UNIQUE REFERENCES handyman_request_inspection_assignments(id),
        scheduling_readiness_id UUID NOT NULL REFERENCES handyman_scheduling_readiness(id),
        reason TEXT NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 10 AND 500),
        planned_by_user_id UUID NOT NULL REFERENCES users(id),
        planned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(handyman_request_id,attempt_number)
      );
      CREATE TRIGGER revisit_immutable BEFORE UPDATE OR DELETE ON handyman_inspection_revisit_attempts
        FOR EACH ROW EXECUTE FUNCTION handyman_prequotation_history_immutable();
      CREATE TRIGGER prequotation_cancelled_guard BEFORE INSERT ON handyman_inspection_revisit_attempts
        FOR EACH ROW EXECUTE FUNCTION handyman_cancelled_request_write_guard();
      ALTER TABLE handyman_request_inspections
        DROP CONSTRAINT handyman_request_inspection_request_unique,
        ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number > 0),
        ADD COLUMN revisit_attempt_id UUID UNIQUE REFERENCES handyman_inspection_revisit_attempts(id),
        ADD COLUMN inspection_assignment_id UUID REFERENCES handyman_request_inspection_assignments(id),
        ADD COLUMN unsuccessful_reason TEXT CHECK(unsuccessful_reason IN ('ACCESS_DENIED','CUSTOMER_UNAVAILABLE','UNSAFE_SITE','SITE_NOT_READY','OTHER')),
        ADD COLUMN evidence_submission_id UUID REFERENCES evidence_submissions(id),
        ADD CONSTRAINT handyman_request_inspection_request_unique UNIQUE(handyman_request_id,attempt_number);

      CREATE FUNCTION handyman_revisit_insert_guard() RETURNS trigger AS $$
      DECLARE r handyman_service_requests%ROWTYPE; i handyman_request_inspections%ROWTYPE;
      BEGIN
        SELECT * INTO r FROM handyman_service_requests WHERE id=NEW.handyman_request_id FOR UPDATE;
        SELECT * INTO i FROM handyman_request_inspections WHERE handyman_request_id=r.id ORDER BY attempt_number DESC LIMIT 1;
        IF r.status <> 'DIAGNOSIS' OR i.id IS DISTINCT FROM NEW.preceding_inspection_id
          OR i.inspection_result <> 'NOT_INSPECTABLE' OR NEW.attempt_number <> i.attempt_number+1
          OR EXISTS(SELECT 1 FROM handyman_request_diagnoses WHERE handyman_request_id=r.id)
          OR EXISTS(SELECT 1 FROM handyman_quotations WHERE handyman_request_id=r.id)
          OR EXISTS(SELECT 1 FROM handyman_execution_scopes WHERE handyman_request_id=r.id)
          OR NOT EXISTS(SELECT 1 FROM handyman_request_inspection_reports rp
            JOIN handyman_request_inspection_report_reviews rv ON rv.report_id=rp.id
            WHERE rp.id=NEW.preceding_report_id AND rp.handyman_request_inspection_id=i.id
              AND rp.handyman_request_id=r.id AND rv.decision='ACCEPTED'
              AND NOT EXISTS(SELECT 1 FROM handyman_request_inspection_reports later
                WHERE later.handyman_request_id=r.id AND later.version_number>rp.version_number))
          OR NOT EXISTS(SELECT 1 FROM handyman_scheduling_readiness sr WHERE sr.id=NEW.scheduling_readiness_id
            AND sr.handyman_request_id=r.id AND sr.client_id=r.client_id AND sr.status='ACTIVE')
          OR NOT EXISTS(SELECT 1 FROM handyman_request_inspection_assignments a
            JOIN handyman_request_inspection_assignments old ON old.id=a.supersedes_assignment_id
            WHERE a.id=NEW.inspection_assignment_id AND a.handyman_request_id=r.id AND a.building_id=r.building_id
              AND a.status='ACTIVE' AND old.status='SUPERSEDED' AND old.superseded_by_assignment_id=a.id
              AND a.assigned_by_user_id=NEW.planned_by_user_id) THEN
          RAISE EXCEPTION 'Revisit requires an accepted failed attempt, fresh assignment and active same-request readiness.'
            USING ERRCODE='23514', CONSTRAINT='handyman_revisit_not_eligible';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER revisit_insert BEFORE INSERT ON handyman_inspection_revisit_attempts
        FOR EACH ROW EXECUTE FUNCTION handyman_revisit_insert_guard();
      CREATE FUNCTION handyman_revisit_project() RETURNS trigger AS $$ BEGIN
        UPDATE handyman_service_requests SET status='INSPECTION_REQUIRED',updated_at=NOW() WHERE id=NEW.handyman_request_id;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER revisit_project AFTER INSERT ON handyman_inspection_revisit_attempts
        FOR EACH ROW EXECUTE FUNCTION handyman_revisit_project();

      CREATE FUNCTION handyman_physical_attempt_guard() RETURNS trigger AS $$
      DECLARE r handyman_service_requests%ROWTYPE; a handyman_request_inspection_assignments%ROWTYPE; previous_number INTEGER;
      BEGIN
        SELECT * INTO r FROM handyman_service_requests WHERE id=NEW.handyman_request_id FOR UPDATE;
        SELECT * INTO a FROM handyman_request_inspection_assignments WHERE handyman_request_id=r.id AND status='ACTIVE';
        SELECT COALESCE(MAX(attempt_number),0) INTO previous_number FROM handyman_request_inspections WHERE handyman_request_id=r.id;
        NEW.inspection_assignment_id := COALESCE(NEW.inspection_assignment_id,a.id);
        IF r.status <> 'INSPECTION_REQUIRED' OR a.id IS NULL OR a.id IS DISTINCT FROM NEW.inspection_assignment_id
          OR a.assigned_field_user_id <> NEW.inspected_by_user_id OR NEW.attempt_number <> previous_number+1
          OR NEW.client_id <> r.client_id OR NEW.building_id <> r.building_id OR NEW.channel_attribution_id <> r.channel_attribution_id
          OR (NEW.attempt_number=1 AND NEW.revisit_attempt_id IS NOT NULL)
          OR (NEW.attempt_number>1 AND NOT EXISTS(SELECT 1 FROM handyman_inspection_revisit_attempts ra
            WHERE ra.id=NEW.revisit_attempt_id AND ra.handyman_request_id=r.id
              AND ra.attempt_number=NEW.attempt_number AND ra.inspection_assignment_id=a.id))
          OR (NEW.inspection_result='NOT_INSPECTABLE' AND NEW.unsuccessful_reason IS NULL)
          OR (NEW.inspection_result='INSPECTED' AND NEW.unsuccessful_reason IS NOT NULL)
          OR (NEW.evidence_submission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evidence_submissions e
            WHERE e.id=NEW.evidence_submission_id AND e.client_id=r.client_id
              AND e.execution_id=r.id AND e.execution_type='HANDYMAN_REQUEST')) THEN
          RAISE EXCEPTION 'Invalid physical inspection attempt or evidence provenance.' USING ERRCODE='23514', CONSTRAINT='handyman_physical_attempt_invalid';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER physical_attempt_insert BEFORE INSERT ON handyman_request_inspections
        FOR EACH ROW EXECUTE FUNCTION handyman_physical_attempt_guard();

      -- Historical immutable reviews are untouched. Acceptance is now unique
      -- per physical inspection, serialized by the same parent lock for SQL too.
      DROP INDEX handyman_request_inspection_review_accepted_unique;
      CREATE FUNCTION handyman_attempt_report_guard() RETURNS trigger AS $$
      DECLARE r handyman_service_requests%ROWTYPE; i handyman_request_inspections%ROWTYPE;
        latest handyman_request_inspection_reports%ROWTYPE; target handyman_request_inspection_reports%ROWTYPE;
      BEGIN
        SELECT * INTO r FROM handyman_service_requests WHERE id=NEW.handyman_request_id FOR UPDATE;
        SELECT * INTO i FROM handyman_request_inspections WHERE handyman_request_id=r.id ORDER BY attempt_number DESC LIMIT 1;
        SELECT * INTO latest FROM handyman_request_inspection_reports WHERE handyman_request_id=r.id ORDER BY version_number DESC LIMIT 1;
        IF r.status <> 'DIAGNOSIS' OR i.id IS NULL OR EXISTS(SELECT 1 FROM handyman_inspection_revisit_attempts
          WHERE handyman_request_id=r.id AND attempt_number>i.attempt_number) THEN
          RAISE EXCEPTION 'Report requires the current completed physical attempt.' USING ERRCODE='23514';
        END IF;
        IF TG_TABLE_NAME='handyman_request_inspection_reports' THEN
          IF NEW.handyman_request_inspection_id <> i.id OR NEW.version_number <> COALESCE(latest.version_number,0)+1
            OR NEW.supersedes_report_id IS DISTINCT FROM latest.id
            OR NOT EXISTS(SELECT 1 FROM handyman_request_inspection_assignments a WHERE a.id=NEW.inspection_assignment_id
              AND a.handyman_request_id=r.id AND a.status='ACTIVE' AND a.assigned_field_user_id=NEW.submitted_by_user_id)
            OR ((latest.id IS NULL OR latest.handyman_request_inspection_id <> i.id) AND NEW.submitted_by_user_id <> i.inspected_by_user_id)
            OR (latest.handyman_request_inspection_id=i.id AND NOT EXISTS(SELECT 1 FROM handyman_request_inspection_report_reviews
              WHERE report_id=latest.id AND decision='RETURNED')) THEN
            RAISE EXCEPTION 'Report corrections and physical revisits are distinct immutable chains.' USING ERRCODE='23514';
          END IF;
        ELSE
          SELECT * INTO target FROM handyman_request_inspection_reports WHERE id=NEW.report_id;
          IF target.id IS DISTINCT FROM latest.id OR target.handyman_request_inspection_id IS DISTINCT FROM i.id THEN
            RAISE EXCEPTION 'Review requires latest report of current physical attempt.' USING ERRCODE='23514';
          END IF;
          IF NEW.decision='ACCEPTED' AND EXISTS(SELECT 1 FROM handyman_request_inspection_report_reviews rv
            JOIN handyman_request_inspection_reports rp ON rp.id=rv.report_id
            WHERE rp.handyman_request_inspection_id=i.id AND rv.decision='ACCEPTED') THEN
            RAISE EXCEPTION 'Physical attempt already has an accepted report.' USING ERRCODE='23505', CONSTRAINT='handyman_request_inspection_review_accepted_unique';
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER attempt_report_insert BEFORE INSERT ON handyman_request_inspection_reports
        FOR EACH ROW EXECUTE FUNCTION handyman_attempt_report_guard();
      CREATE TRIGGER attempt_review_insert BEFORE INSERT ON handyman_request_inspection_report_reviews
        FOR EACH ROW EXECUTE FUNCTION handyman_attempt_report_guard();

      CREATE FUNCTION handyman_has_successful_inspection(request_id UUID) RETURNS boolean AS $$
        SELECT EXISTS(SELECT 1 FROM handyman_request_inspections i
          JOIN handyman_request_inspection_reports rp ON rp.handyman_request_inspection_id=i.id
          JOIN handyman_request_inspection_report_reviews rv ON rv.report_id=rp.id AND rv.decision='ACCEPTED'
          WHERE i.handyman_request_id=request_id AND i.inspection_result='INSPECTED'
            AND NOT EXISTS(SELECT 1 FROM handyman_request_inspections later WHERE later.handyman_request_id=request_id AND later.attempt_number>i.attempt_number)
            AND NOT EXISTS(SELECT 1 FROM handyman_inspection_revisit_attempts pending WHERE pending.handyman_request_id=request_id AND pending.attempt_number>i.attempt_number)
            AND NOT EXISTS(SELECT 1 FROM handyman_request_inspection_reports later WHERE later.handyman_request_id=request_id AND later.version_number>rp.version_number))
      $$ LANGUAGE sql STABLE;
      CREATE FUNCTION handyman_successful_inspection_guard() RETURNS trigger AS $$
      DECLARE request_id UUID;
      BEGIN
        IF TG_TABLE_NAME='handyman_quotation_versions' THEN
          SELECT handyman_request_id INTO request_id FROM handyman_quotations WHERE id=NEW.quotation_id;
        ELSE request_id := NEW.handyman_request_id;
        END IF;
        PERFORM 1 FROM handyman_service_requests WHERE id=request_id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM handyman_request_triage_decisions WHERE handyman_request_id=request_id AND triage_disposition='INSPECTION_REQUIRED')
          AND NOT handyman_has_successful_inspection(request_id) THEN
          RAISE EXCEPTION 'Preparation requires a successful current accepted inspection.' USING ERRCODE='23514', CONSTRAINT='handyman_successful_inspection_required';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER successful_inspection_insert BEFORE INSERT ON handyman_request_diagnoses
        FOR EACH ROW EXECUTE FUNCTION handyman_successful_inspection_guard();
      CREATE TRIGGER successful_inspection_insert BEFORE INSERT ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION handyman_successful_inspection_guard();
    `);
  },
  async down() {
    // Removing this authority could collapse separately accepted physical
    // histories into the obsolete one-inspection constraint. Forward-only.
    throw new Error('Inspection revisit history is forward-only; use a corrective migration.');
  },
};
