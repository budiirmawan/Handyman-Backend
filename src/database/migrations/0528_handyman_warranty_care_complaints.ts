import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Prospective Care complaint intake. A complaint is a report, not a coverage
 * determination. Attachments use the shared evidence store under their OWN
 * parent kind, never masquerading as request-intake or field/crew evidence.
 * The only bridge to assessment is a byte-verified, explicitly sourced DEFECT
 * evidence record and the existing certificate-bound claim/assessment engine.
 */
export const migration0528HandymanWarrantyCareComplaints: Migration = {
  id: '0528_handyman_warranty_care_complaints',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE SEQUENCE handyman_warranty_complaint_number_seq AS BIGINT;
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution CHECK (execution_type IN (
          'FORM_INSTANCE','CHECKLIST_EXECUTION','WORK_ORDER','VENDOR_WORK',
          'UTILITY_METER_READING','PERMIT','FINDING','FINDING_REWORK','FINDING_VERIFICATION',
          'HANDYMAN_REQUEST','HANDYMAN_CUSTOMER_PAYMENT','HANDYMAN_WARRANTY_COMPLAINT')),
        ADD CONSTRAINT evidence_handyman_complaint_metadata_check CHECK (
          execution_type <> 'HANDYMAN_WARRANTY_COMPLAINT' OR (
            file_reference='evidence/' || id::text AND file_size > 0 AND captured_at IS NULL
            AND submitted_by_user_id IS NOT NULL AND content_sha256 IS NOT NULL
            AND ((evidence_type='PHOTO' AND mime_type IN ('image/jpeg','image/png','image/webp'))
              OR (evidence_type='DOCUMENT' AND mime_type='application/pdf')
              OR (evidence_type='VIDEO' AND mime_type IN ('video/mp4','video/quicktime')))));

      CREATE FUNCTION hm_warranty_complaint_care_authorized(actor UUID, client UUID, building UUID)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM users u
          JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
          JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
          JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
          JOIN permissions p ON p.id=rpa.permission_id AND p.status='ACTIVE' AND p.code='handyman.care.building'
          JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=building AND a.status='ACTIVE'
          JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
          JOIN properties pr ON pr.id=b.property_id AND pr.client_id=client
          WHERE u.id=actor AND u.status='ACTIVE')
      $$;

      CREATE TABLE handyman_warranty_complaints (
        id UUID PRIMARY KEY,
        complaint_number TEXT NOT NULL UNIQUE DEFAULT
          ('WC-' || to_char(clock_timestamp(),'YYYY') || '-' || nextval('handyman_warranty_complaint_number_seq')::text),
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        handyman_request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        space_id UUID REFERENCES spaces(id),
        reported_certificate_id UUID REFERENCES handyman_warranty_certificates(id),
        reported_item_line_id UUID REFERENCES handyman_quotation_lines(id),
        channel TEXT NOT NULL CHECK (channel IN ('WHATSAPP','PHONE','EMAIL','DIRECT')),
        channel_reference TEXT CHECK (channel_reference IS NULL OR length(btrim(channel_reference)) BETWEEN 1 AND 200),
        reported_reporter_name TEXT NOT NULL CHECK (length(btrim(reported_reporter_name)) BETWEEN 1 AND 200),
        reported_reporter_contact TEXT CHECK (reported_reporter_contact IS NULL OR length(btrim(reported_reporter_contact)) BETWEEN 1 AND 200),
        reported_reporter_pic_id UUID REFERENCES tenant_pics(id),
        tenant_description TEXT NOT NULL CHECK (length(btrim(tenant_description)) BETWEEN 1 AND 2000),
        internal_care_notes TEXT CHECK (internal_care_notes IS NULL OR length(btrim(internal_care_notes)) BETWEEN 1 AND 4000),
        complaint_date DATE NOT NULL,
        occurrence_date DATE,
        recorded_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        command_sha256 TEXT NOT NULL CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (occurrence_date IS NULL OR occurrence_date <= complaint_date),
        CHECK (reported_item_line_id IS NULL OR reported_certificate_id IS NOT NULL),
        UNIQUE (recorded_by_user_id,idempotency_key)
      );
      CREATE UNIQUE INDEX hm_warranty_complaint_channel_ref_unique
        ON handyman_warranty_complaints(client_id,building_id,channel,channel_reference)
        WHERE channel_reference IS NOT NULL;
      CREATE INDEX hm_warranty_complaint_building_idx
        ON handyman_warranty_complaints(client_id,building_id,created_at DESC,id);

      CREATE FUNCTION hm_warranty_complaint_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT hm_warranty_complaint_care_authorized(NEW.recorded_by_user_id,NEW.client_id,NEW.building_id)
          OR NOT EXISTS (SELECT 1 FROM handyman_service_requests r WHERE r.id=NEW.handyman_request_id
            AND r.client_id=NEW.client_id AND r.building_id=NEW.building_id
            AND r.tenant_company_id=NEW.tenant_company_id AND r.space_id IS NOT DISTINCT FROM NEW.space_id)
          OR (NEW.reported_reporter_pic_id IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM tenant_pics p WHERE p.id=NEW.reported_reporter_pic_id
              AND p.tenant_company_id=NEW.tenant_company_id AND p.status='ACTIVE'))
          OR (NEW.reported_certificate_id IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM handyman_warranty_certificates c WHERE c.id=NEW.reported_certificate_id
              AND c.client_id=NEW.client_id AND c.building_id=NEW.building_id
              AND c.request_id=NEW.handyman_request_id AND c.tenant_company_id=NEW.tenant_company_id
              AND (NEW.reported_item_line_id IS NULL OR EXISTS
                (SELECT 1 FROM jsonb_array_elements(c.source_snapshot->'items') i
                  WHERE i->>'rootLineId'=NEW.reported_item_line_id::text))))
        THEN RAISE EXCEPTION 'Complaint requires the exact Care, request, tenant, unit and optional certificate scope.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_insert BEFORE INSERT ON handyman_warranty_complaints
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_insert_guard();

      CREATE TABLE handyman_warranty_complaint_evidence (
        complaint_id UUID NOT NULL REFERENCES handyman_warranty_complaints(id),
        evidence_submission_id UUID PRIMARY KEY REFERENCES evidence_submissions(id),
        uploaded_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        command_sha256 TEXT NOT NULL CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (complaint_id,evidence_submission_id), UNIQUE (complaint_id,idempotency_key)
      );
      CREATE FUNCTION hm_warranty_complaint_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_warranty_complaints c
          JOIN evidence_submissions e ON e.id=NEW.evidence_submission_id
          WHERE c.id=NEW.complaint_id AND e.execution_type='HANDYMAN_WARRANTY_COMPLAINT'
            AND e.execution_id=c.id AND e.client_id=c.client_id AND e.status='ACTIVE'
            AND e.submitted_by_user_id=NEW.uploaded_by_user_id
            AND hm_warranty_complaint_care_authorized(NEW.uploaded_by_user_id,c.client_id,c.building_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_warranty_complaint_claim_links l
              JOIN handyman_warranty_claim_assessments a ON a.claim_id=l.claim_id
              WHERE l.complaint_id=c.id AND a.reviewer_user_id=NEW.uploaded_by_user_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_warranty_complaint_claim_links l
              JOIN handyman_service_warranty_claims cl ON cl.id=l.claim_id
              WHERE l.complaint_id=c.id AND cl.decided_by_user_id=NEW.uploaded_by_user_id))
        THEN RAISE EXCEPTION 'Complaint evidence must be scoped, managed and attributed to the actual Care uploader.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_evidence_insert BEFORE INSERT ON handyman_warranty_complaint_evidence
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_evidence_guard();

      -- Protect provenance while leaving retention state/holds available to the shared engine.
      CREATE FUNCTION hm_warranty_complaint_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' AND OLD.execution_type='HANDYMAN_WARRANTY_COMPLAINT' THEN
          RAISE EXCEPTION 'Complaint evidence provenance cannot be deleted.' USING ERRCODE='23514';
        END IF;
        IF TG_OP='UPDATE' AND (OLD.execution_type='HANDYMAN_WARRANTY_COMPLAINT' OR NEW.execution_type='HANDYMAN_WARRANTY_COMPLAINT') THEN
          IF ROW(NEW.id,NEW.client_id,NEW.execution_type,NEW.execution_id,NEW.evidence_type,NEW.file_reference,
            NEW.original_file_name,NEW.mime_type,NEW.file_size,NEW.captured_at,NEW.submitted_by_user_id,
            NEW.content_sha256,NEW.content_hashed_at,NEW.hash_algorithm)
            IS DISTINCT FROM ROW(OLD.id,OLD.client_id,OLD.execution_type,OLD.execution_id,OLD.evidence_type,OLD.file_reference,
            OLD.original_file_name,OLD.mime_type,OLD.file_size,OLD.captured_at,OLD.submitted_by_user_id,
            OLD.content_sha256,OLD.content_hashed_at,OLD.hash_algorithm)
          THEN RAISE EXCEPTION 'Complaint evidence provenance is immutable.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN COALESCE(NEW,OLD);
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_submission_protect BEFORE UPDATE OR DELETE ON evidence_submissions
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_submission_guard();
      CREATE FUNCTION hm_warranty_complaint_submission_owner_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.execution_type='HANDYMAN_WARRANTY_COMPLAINT' AND NOT EXISTS
          (SELECT 1 FROM handyman_warranty_complaint_evidence ce
            WHERE ce.evidence_submission_id=NEW.id AND ce.complaint_id=NEW.execution_id)
        THEN RAISE EXCEPTION 'Complaint evidence requires its explicit complaint owner.' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_warranty_complaint_submission_owner AFTER INSERT ON evidence_submissions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_submission_owner_required();

      -- Optional self-confirmation is identity only, not consent or a coverage decision.
      CREATE TABLE handyman_warranty_complaint_reporter_confirmations (
        complaint_id UUID PRIMARY KEY REFERENCES handyman_warranty_complaints(id),
        tenant_pic_id UUID NOT NULL REFERENCES tenant_pics(id),
        user_id UUID NOT NULL REFERENCES users(id),
        session_id UUID NOT NULL REFERENCES user_sessions(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_complaint_reporter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_warranty_complaints c
          JOIN tenant_pics p ON p.id=NEW.tenant_pic_id AND (c.reported_reporter_pic_id IS NULL OR p.id=c.reported_reporter_pic_id)
            AND p.tenant_company_id=c.tenant_company_id AND p.status='ACTIVE' AND p.user_id=NEW.user_id
          JOIN users u ON u.id=NEW.user_id AND u.status='ACTIVE'
          JOIN user_sessions s ON s.id=NEW.session_id AND s.user_id=u.id AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
          WHERE c.id=NEW.complaint_id
            AND NOT EXISTS (SELECT 1 FROM handyman_warranty_complaint_claim_links l
              JOIN handyman_warranty_claim_assessments a ON a.claim_id=l.claim_id
              WHERE l.complaint_id=c.id AND a.reviewer_user_id=NEW.user_id)
            AND NOT EXISTS (SELECT 1 FROM handyman_warranty_complaint_claim_links l
              JOIN handyman_service_warranty_claims cl ON cl.id=l.claim_id
              WHERE l.complaint_id=c.id AND cl.decided_by_user_id=NEW.user_id))
        THEN RAISE EXCEPTION 'Reporter identity must be self-confirmed by the exact active Tenant PIC session.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_reporter_insert BEFORE INSERT ON handyman_warranty_complaint_reporter_confirmations
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_reporter_guard();

      CREATE TABLE handyman_warranty_complaint_claim_links (
        complaint_id UUID PRIMARY KEY REFERENCES handyman_warranty_complaints(id),
        claim_id UUID NOT NULL UNIQUE REFERENCES handyman_service_warranty_claims(id),
        evidence_record_id UUID NOT NULL UNIQUE REFERENCES handyman_evidence_records(id),
        submitted_by_user_id UUID NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        command_sha256 TEXT NOT NULL CHECK (command_sha256 ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_complaint_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_warranty_complaints c
          JOIN handyman_service_warranty_claims cl ON cl.id=NEW.claim_id AND cl.client_id=c.client_id
            AND cl.status='CLAIM_SUBMITTED' AND cl.opened_by_user_id=NEW.submitted_by_user_id
            AND cl.claimant_user_id=NEW.submitted_by_user_id AND cl.evidence_record_id=NEW.evidence_record_id
          JOIN handyman_execution_scopes s ON s.id=cl.execution_scope_id AND s.client_id=c.client_id
            AND s.handyman_request_id=c.handyman_request_id AND s.building_id=c.building_id
            AND s.tenant_company_id=c.tenant_company_id AND s.space_id IS NOT DISTINCT FROM c.space_id
          JOIN handyman_warranty_claim_bindings b ON b.claim_id=cl.id
          JOIN handyman_warranty_certificates cert ON cert.id=b.certificate_id AND cert.request_id=c.handyman_request_id
            AND cert.building_id=c.building_id AND cert.client_id=c.client_id AND cert.tenant_company_id=c.tenant_company_id
          JOIN handyman_evidence_records er ON er.id=NEW.evidence_record_id AND er.execution_scope_id=s.id
            AND er.client_id=c.client_id AND er.stage='DEFECT' AND er.session_id IS NULL
          WHERE c.id=NEW.complaint_id AND hm_warranty_complaint_care_authorized(NEW.submitted_by_user_id,c.client_id,c.building_id)
            AND (c.reported_certificate_id IS NULL OR c.reported_certificate_id=b.certificate_id)
            AND (c.reported_item_line_id IS NULL OR c.reported_item_line_id=b.item_line_id)
            AND EXISTS (SELECT 1 FROM handyman_evidence_record_events e WHERE e.record_id=er.id AND e.event_type='FINALIZE')
            AND EXISTS (SELECT 1 FROM handyman_warranty_complaint_evidence ce
              JOIN evidence_submissions es ON es.id=ce.evidence_submission_id AND es.status='ACTIVE'
              JOIN handyman_evidence_record_files f ON f.record_id=er.id AND f.storage_key=es.file_reference
                AND f.sha256_digest=es.content_sha256 AND f.byte_size=es.file_size
                AND f.content_type=es.mime_type AND f.media_kind=es.evidence_type
              WHERE ce.complaint_id=c.id))
        THEN RAISE EXCEPTION 'Complaint claim must use its exact request, certificate, item and sourced evidence.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_claim_insert BEFORE INSERT ON handyman_warranty_complaint_claim_links
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_claim_guard();

      CREATE TABLE handyman_warranty_complaint_evidence_bridges (
        complaint_id UUID NOT NULL REFERENCES handyman_warranty_complaint_claim_links(complaint_id),
        evidence_submission_id UUID NOT NULL UNIQUE REFERENCES handyman_warranty_complaint_evidence(evidence_submission_id),
        evidence_record_id UUID NOT NULL REFERENCES handyman_evidence_records(id),
        evidence_file_id UUID NOT NULL UNIQUE REFERENCES handyman_evidence_record_files(id),
        bridged_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (complaint_id,evidence_submission_id)
          REFERENCES handyman_warranty_complaint_evidence(complaint_id,evidence_submission_id)
      );
      CREATE FUNCTION hm_warranty_complaint_bridge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_warranty_complaint_claim_links l
          JOIN handyman_warranty_complaints c ON c.id=l.complaint_id
          JOIN handyman_service_warranty_claims cl ON cl.id=l.claim_id
          JOIN handyman_warranty_complaint_evidence ce ON ce.complaint_id=c.id AND ce.evidence_submission_id=NEW.evidence_submission_id
          JOIN evidence_submissions es ON es.id=ce.evidence_submission_id AND es.status='ACTIVE'
          JOIN handyman_evidence_records er ON er.id=NEW.evidence_record_id AND er.client_id=c.client_id
            AND er.execution_scope_id=cl.execution_scope_id AND er.stage='DEFECT' AND er.session_id IS NULL
          JOIN handyman_evidence_record_files f ON f.id=NEW.evidence_file_id AND f.record_id=er.id
            AND f.storage_key=es.file_reference AND f.sha256_digest=es.content_sha256
            AND f.byte_size=es.file_size AND f.content_type=es.mime_type AND f.media_kind=es.evidence_type
          WHERE l.complaint_id=NEW.complaint_id
            AND hm_warranty_complaint_care_authorized(NEW.bridged_by_user_id,c.client_id,c.building_id)
            AND EXISTS (SELECT 1 FROM handyman_evidence_record_events e WHERE e.record_id=er.id
              AND e.event_type='FINALIZE' AND e.actor_user_id=NEW.bridged_by_user_id)
            AND EXISTS (SELECT 1 FROM handyman_evidence_record_events e WHERE e.record_id=er.id
              AND e.event_type='FILE_ADD' AND e.actor_user_id=NEW.bridged_by_user_id))
        THEN RAISE EXCEPTION 'Evidence bridge must preserve the exact complaint file and actual Care actor.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_bridge_insert BEFORE INSERT ON handyman_warranty_complaint_evidence_bridges
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_bridge_guard();

      -- The original engine's opener/PIC separation is strengthened only for
      -- complaint-linked claims: all real complaint participants are excluded.
      CREATE FUNCTION hm_warranty_complaint_assessor_independent(claim_uuid UUID, actor_uuid UUID)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
        SELECT NOT EXISTS (SELECT 1 FROM handyman_warranty_complaint_claim_links l
          JOIN handyman_warranty_complaints c ON c.id=l.complaint_id
          WHERE l.claim_id=claim_uuid AND (c.recorded_by_user_id=actor_uuid
            OR EXISTS (SELECT 1 FROM tenant_pics p WHERE p.id=c.reported_reporter_pic_id AND p.user_id=actor_uuid)
            OR EXISTS (SELECT 1 FROM handyman_warranty_complaint_reporter_confirmations r
              WHERE r.complaint_id=c.id AND r.user_id=actor_uuid)
            OR EXISTS (SELECT 1 FROM handyman_warranty_complaint_evidence e
              WHERE e.complaint_id=c.id AND e.uploaded_by_user_id=actor_uuid)
            OR EXISTS (SELECT 1 FROM handyman_warranty_complaint_evidence_bridges b
              WHERE b.complaint_id=c.id AND b.bridged_by_user_id=actor_uuid)))
      $$;
      CREATE FUNCTION hm_warranty_complaint_assessment_independence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT hm_warranty_complaint_assessor_independent(NEW.claim_id,NEW.reviewer_user_id) THEN
          RAISE EXCEPTION 'A complaint participant cannot independently assess its claim.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_assessment_independence BEFORE INSERT ON handyman_warranty_claim_assessments
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_assessment_independence_guard();
      CREATE FUNCTION hm_warranty_complaint_decision_independence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status='CLAIM_SUBMITTED' AND NEW.status IN ('CLAIM_APPROVED','CLAIM_REJECTED')
          AND NOT hm_warranty_complaint_assessor_independent(NEW.id,NEW.decided_by_user_id) THEN
          RAISE EXCEPTION 'A complaint participant cannot independently decide its claim.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_decision_independence BEFORE UPDATE ON handyman_service_warranty_claims
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_decision_independence_guard();

      -- Any reuse of a complaint-owned key by an execution evidence file
      -- must have the explicit complaint/claim bridge by transaction commit.
      CREATE FUNCTION hm_warranty_complaint_record_file_owner_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM evidence_submissions e WHERE e.execution_type='HANDYMAN_WARRANTY_COMPLAINT'
            AND e.file_reference=NEW.storage_key) AND NOT EXISTS
          (SELECT 1 FROM handyman_warranty_complaint_evidence_bridges b
            JOIN evidence_submissions e ON e.id=b.evidence_submission_id
            WHERE b.evidence_file_id=NEW.id AND b.evidence_record_id=NEW.record_id AND e.file_reference=NEW.storage_key)
        THEN RAISE EXCEPTION 'Complaint files require the explicit scoped complaint evidence bridge.' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_warranty_complaint_record_file_owner AFTER INSERT ON handyman_evidence_record_files
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_record_file_owner_required();

      CREATE TABLE handyman_warranty_complaint_events (
        id UUID PRIMARY KEY,
        complaint_id UUID NOT NULL REFERENCES handyman_warranty_complaints(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('REGISTERED','EVIDENCE_ADDED','REPORTER_SELF_CONFIRMED','CLAIM_SUBMITTED')),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        session_id UUID NOT NULL REFERENCES user_sessions(id),
        reference_id UUID,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE FUNCTION hm_warranty_complaint_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_user_id
          AND s.status='ACTIVE' AND s.expires_at>clock_timestamp())
        THEN RAISE EXCEPTION 'Complaint event requires the real authenticated session.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_warranty_complaint_event_insert BEFORE INSERT ON handyman_warranty_complaint_events
        FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_event_guard();
      CREATE INDEX hm_warranty_complaint_event_idx ON handyman_warranty_complaint_events(complaint_id,occurred_at,id);

      CREATE FUNCTION hm_warranty_complaint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Warranty complaint facts and history are immutable.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_warranty_complaint_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_complaints FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_evidence_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_complaint_evidence FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_reporter_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_complaint_reporter_confirmations FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_claim_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_complaint_claim_links FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_bridge_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_complaint_evidence_bridges FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_event_no_write BEFORE UPDATE OR DELETE ON handyman_warranty_complaint_events FOR EACH ROW EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_no_truncate BEFORE TRUNCATE ON handyman_warranty_complaints FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_evidence_no_truncate BEFORE TRUNCATE ON handyman_warranty_complaint_evidence FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_reporter_no_truncate BEFORE TRUNCATE ON handyman_warranty_complaint_reporter_confirmations FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_claim_no_truncate BEFORE TRUNCATE ON handyman_warranty_complaint_claim_links FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_bridge_no_truncate BEFORE TRUNCATE ON handyman_warranty_complaint_evidence_bridges FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_complaint_immutable();
      CREATE TRIGGER hm_warranty_complaint_event_no_truncate BEFORE TRUNCATE ON handyman_warranty_complaint_events FOR EACH STATEMENT EXECUTE FUNCTION hm_warranty_complaint_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_warranty_complaints) THEN
        RAISE EXCEPTION 'Cannot remove warranty complaint history.' USING ERRCODE='23514'; END IF; END $$;
      DROP TRIGGER hm_warranty_complaint_assessment_independence ON handyman_warranty_claim_assessments;
      DROP TRIGGER hm_warranty_complaint_decision_independence ON handyman_service_warranty_claims;
      DROP TRIGGER hm_warranty_complaint_record_file_owner ON handyman_evidence_record_files;
      DROP TRIGGER hm_warranty_complaint_submission_owner ON evidence_submissions;
      DROP TRIGGER hm_warranty_complaint_submission_protect ON evidence_submissions;
      DROP TABLE handyman_warranty_complaint_events, handyman_warranty_complaint_evidence_bridges,
        handyman_warranty_complaint_claim_links, handyman_warranty_complaint_reporter_confirmations,
        handyman_warranty_complaint_evidence, handyman_warranty_complaints;
      DROP FUNCTION hm_warranty_complaint_assessment_independence_guard(), hm_warranty_complaint_decision_independence_guard(),
        hm_warranty_complaint_assessor_independent(UUID,UUID), hm_warranty_complaint_record_file_owner_required(),
        hm_warranty_complaint_event_guard(), hm_warranty_complaint_bridge_guard(),
        hm_warranty_complaint_claim_guard(), hm_warranty_complaint_reporter_guard(),
        hm_warranty_complaint_submission_owner_required(), hm_warranty_complaint_submission_guard(),
        hm_warranty_complaint_evidence_guard(), hm_warranty_complaint_insert_guard(),
        hm_warranty_complaint_immutable(), hm_warranty_complaint_care_authorized(UUID,UUID,UUID);
      DROP SEQUENCE handyman_warranty_complaint_number_seq;
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_handyman_complaint_metadata_check,
        DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution CHECK (execution_type IN (
          'FORM_INSTANCE','CHECKLIST_EXECUTION','WORK_ORDER','VENDOR_WORK','UTILITY_METER_READING','PERMIT',
          'FINDING','FINDING_REWORK','FINDING_VERIFICATION','HANDYMAN_REQUEST','HANDYMAN_CUSTOMER_PAYMENT'));
    `);
  },
};
