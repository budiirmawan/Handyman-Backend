import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** A delivery journal records facts about an issued document, not settlement. */
export const migration0531HandymanFinalReceiptDelivery: Migration = {
  id: '0531_handyman_final_receipt_delivery',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution CHECK (execution_type IN (
          'FORM_INSTANCE','CHECKLIST_EXECUTION','WORK_ORDER','VENDOR_WORK','UTILITY_METER_READING','PERMIT',
          'FINDING','FINDING_REWORK','FINDING_VERIFICATION','HANDYMAN_REQUEST','HANDYMAN_CUSTOMER_PAYMENT',
          'HANDYMAN_WARRANTY_COMPLAINT','HANDYMAN_FINAL_RECEIPT_DELIVERY')),
        ADD CONSTRAINT hm_final_delivery_evidence_metadata CHECK (
          execution_type <> 'HANDYMAN_FINAL_RECEIPT_DELIVERY' OR (
            file_reference='evidence/' || id::text AND file_size BETWEEN 1 AND 10485760
            AND captured_at IS NULL AND content_sha256 IS NOT NULL AND content_hashed_at IS NOT NULL
            AND hash_algorithm='SHA-256' AND ((evidence_type='DOCUMENT' AND mime_type='application/pdf')
              OR (evidence_type='PHOTO' AND mime_type IN ('image/jpeg','image/png','image/webp')))));

      CREATE TABLE handyman_final_receipt_delivery_evidence (
        evidence_id uuid PRIMARY KEY REFERENCES evidence_submissions(id),
        receipt_id uuid NOT NULL REFERENCES handyman_final_receipts(id),
        uploaded_by_user_id uuid REFERENCES users(id),
        uploaded_user_session_id uuid REFERENCES user_sessions(id),
        uploaded_by_care_actor_id uuid REFERENCES handyman_handoff_care_actors(id),
        uploaded_care_session_id uuid REFERENCES handyman_care_workspace_sessions(id),
        idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((uploaded_by_user_id IS NOT NULL AND uploaded_user_session_id IS NOT NULL
          AND uploaded_by_care_actor_id IS NULL AND uploaded_care_session_id IS NULL)
          OR (uploaded_by_user_id IS NULL AND uploaded_user_session_id IS NULL
          AND uploaded_by_care_actor_id IS NOT NULL AND uploaded_care_session_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX hm_final_delivery_evidence_local_key ON handyman_final_receipt_delivery_evidence(uploaded_by_user_id,idempotency_key)
        WHERE uploaded_by_user_id IS NOT NULL;
      CREATE UNIQUE INDEX hm_final_delivery_evidence_care_key ON handyman_final_receipt_delivery_evidence(uploaded_by_care_actor_id,idempotency_key)
        WHERE uploaded_by_care_actor_id IS NOT NULL;

      CREATE TABLE handyman_final_receipt_delivery_events (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES clients(id), building_id uuid NOT NULL REFERENCES buildings(id),
        request_id uuid NOT NULL REFERENCES handyman_service_requests(id), tenant_company_id uuid NOT NULL REFERENCES tenant_companies(id),
        receipt_id uuid NOT NULL REFERENCES handyman_final_receipts(id), document_version integer NOT NULL CHECK(document_version=1),
        source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'), pdf_sha256 text NOT NULL CHECK(pdf_sha256 ~ '^[0-9a-f]{64}$'),
        event_type text NOT NULL CHECK(event_type IN ('DOWNLOADED','SENT','DELIVERED')),
        channel text CHECK(channel IN ('WHATSAPP','EMAIL','DIRECT')),
        recipient_name text CHECK(recipient_name IS NULL OR length(btrim(recipient_name)) BETWEEN 1 AND 200),
        recipient_contact text CHECK(recipient_contact IS NULL OR length(btrim(recipient_contact)) BETWEEN 1 AND 200),
        recipient_pic_id uuid REFERENCES tenant_pics(id),
        sent_event_id uuid REFERENCES handyman_final_receipt_delivery_events(id),
        evidence_id uuid REFERENCES handyman_final_receipt_delivery_evidence(evidence_id),
        evidence_sha256 text CHECK(evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
        actor_user_id uuid REFERENCES users(id), actor_user_session_id uuid REFERENCES user_sessions(id),
        care_actor_id uuid REFERENCES handyman_handoff_care_actors(id), care_session_id uuid REFERENCES handyman_care_workspace_sessions(id),
        idempotency_key text CHECK(idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        payload_sha256 text CHECK(payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
        reported_occurred_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((actor_user_id IS NOT NULL AND actor_user_session_id IS NOT NULL AND care_actor_id IS NULL AND care_session_id IS NULL)
          OR (actor_user_id IS NULL AND actor_user_session_id IS NULL AND care_actor_id IS NOT NULL AND care_session_id IS NOT NULL)),
        CHECK (reported_occurred_at IS NULL OR reported_occurred_at<=recorded_at),
        CHECK ((event_type='DOWNLOADED' AND channel IS NULL AND recipient_name IS NULL AND recipient_contact IS NULL
          AND recipient_pic_id IS NULL AND sent_event_id IS NULL AND evidence_id IS NULL AND evidence_sha256 IS NULL
          AND idempotency_key IS NULL AND payload_sha256 IS NULL AND reported_occurred_at IS NULL)
          OR (event_type='SENT' AND channel IS NOT NULL AND recipient_name IS NOT NULL
          AND (channel='DIRECT' OR recipient_contact IS NOT NULL) AND sent_event_id IS NULL
          AND evidence_id IS NOT NULL AND evidence_sha256 IS NOT NULL AND reported_occurred_at IS NOT NULL
          AND idempotency_key IS NOT NULL AND payload_sha256 IS NOT NULL)
          OR (event_type='DELIVERED' AND channel IS NOT NULL AND recipient_name IS NOT NULL
          AND (channel='DIRECT' OR recipient_contact IS NOT NULL) AND recipient_pic_id IS NOT NULL AND sent_event_id IS NOT NULL
          AND evidence_id IS NULL AND evidence_sha256 IS NULL AND actor_user_id IS NOT NULL AND care_actor_id IS NULL
          AND idempotency_key IS NOT NULL AND payload_sha256 IS NOT NULL AND reported_occurred_at IS NULL))
      );
      CREATE INDEX hm_final_delivery_history ON handyman_final_receipt_delivery_events(client_id,building_id,request_id,receipt_id,recorded_at,id);
      CREATE UNIQUE INDEX hm_final_delivery_local_key ON handyman_final_receipt_delivery_events(actor_user_id,idempotency_key)
        WHERE actor_user_id IS NOT NULL AND idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX hm_final_delivery_care_key ON handyman_final_receipt_delivery_events(care_actor_id,idempotency_key)
        WHERE care_actor_id IS NOT NULL AND idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX hm_final_delivery_one_ack ON handyman_final_receipt_delivery_events(sent_event_id) WHERE event_type='DELIVERED';

      -- Local authentication + scoped Care/Finance, or a current workspace
      -- session. The application additionally locks the workspace occupancy.
      CREATE FUNCTION hm_final_delivery_actor_valid(local_user uuid,local_session uuid,care_actor uuid,care_session uuid,
        client uuid,building uuid,kind text) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT CASE WHEN local_user IS NOT NULL THEN EXISTS (
          SELECT 1 FROM users u JOIN user_sessions s ON s.user_id=u.id
          JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=building AND a.status='ACTIVE'
          JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
          JOIN properties pr ON pr.id=b.property_id AND pr.client_id=client
          JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
          JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
          JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
          JOIN permissions p ON p.id=rpa.permission_id AND p.status='ACTIVE'
          WHERE u.id=local_user AND u.status='ACTIVE' AND s.id=local_session AND s.status='ACTIVE'
            AND s.expires_at>clock_timestamp() AND (p.code='handyman.care.building'
              OR (kind='DOWNLOADED' AND p.code='handyman.finance.read')))
        ELSE EXISTS (
          SELECT 1 FROM handyman_care_workspace_sessions s JOIN handyman_handoff_care_actors a ON a.id=s.care_actor_id
          JOIN handyman_handoff_integrations i ON i.id=s.integration_id AND i.id=a.integration_id
          WHERE s.id=care_session AND s.care_actor_id=care_actor AND s.revoked_at IS NULL
            AND s.expires_at>clock_timestamp() AND a.status='ACTIVE' AND i.status='ACTIVE' AND i.actor_capability='CUSTOMER_CARE') END;
      $$;

      CREATE FUNCTION hm_final_delivery_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_final_receipts f JOIN evidence_submissions e ON e.id=NEW.evidence_id
          WHERE f.id=NEW.receipt_id AND f.status='ISSUED' AND e.client_id=f.client_id
          AND e.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY' AND e.execution_id=f.id
          AND e.submitted_by_user_id IS NOT DISTINCT FROM NEW.uploaded_by_user_id AND e.status='ACTIVE'
          AND hm_final_delivery_actor_valid(NEW.uploaded_by_user_id,NEW.uploaded_user_session_id,
            NEW.uploaded_by_care_actor_id,NEW.uploaded_care_session_id,f.client_id,f.building_id,'SENT'))
        THEN RAISE EXCEPTION 'Evidence must belong to the exact issued receipt and scoped authenticated Care.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_final_delivery_evidence_insert BEFORE INSERT ON handyman_final_receipt_delivery_evidence
        FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_evidence_guard();

      CREATE FUNCTION hm_final_delivery_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' AND OLD.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY' THEN
          RAISE EXCEPTION 'Delivery evidence provenance cannot be deleted.' USING ERRCODE='23514';
        END IF;
        IF TG_OP='UPDATE' AND (OLD.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY' OR NEW.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY') AND
          ROW(NEW.id,NEW.client_id,NEW.execution_type,NEW.execution_id,NEW.evidence_type,NEW.file_reference,NEW.original_file_name,
            NEW.mime_type,NEW.file_size,NEW.captured_at,NEW.submitted_by_user_id,NEW.content_sha256,NEW.content_hashed_at,NEW.hash_algorithm)
          IS DISTINCT FROM ROW(OLD.id,OLD.client_id,OLD.execution_type,OLD.execution_id,OLD.evidence_type,OLD.file_reference,OLD.original_file_name,
            OLD.mime_type,OLD.file_size,OLD.captured_at,OLD.submitted_by_user_id,OLD.content_sha256,OLD.content_hashed_at,OLD.hash_algorithm)
        THEN RAISE EXCEPTION 'Delivery evidence provenance is immutable.' USING ERRCODE='23514'; END IF;
        RETURN COALESCE(NEW,OLD);
      END; $$;
      CREATE TRIGGER hm_final_delivery_submission_protect BEFORE UPDATE OR DELETE ON evidence_submissions
        FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_submission_guard();
      CREATE FUNCTION hm_final_delivery_submission_owner_required() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY' AND NOT EXISTS
          (SELECT 1 FROM handyman_final_receipt_delivery_evidence e WHERE e.evidence_id=NEW.id AND e.receipt_id=NEW.execution_id)
        THEN RAISE EXCEPTION 'Delivery evidence requires its exact receipt binding.' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER hm_final_delivery_submission_owner AFTER INSERT ON evidence_submissions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_submission_owner_required();

      -- Delivery proof is not completion/QC evidence and has no implicit bridge.
      CREATE FUNCTION hm_final_delivery_no_field_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM evidence_submissions e WHERE e.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY'
          AND e.file_reference=NEW.storage_key)
        THEN RAISE EXCEPTION 'Delivery evidence cannot be reused as field evidence.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_final_delivery_field_no_reuse BEFORE INSERT ON handyman_evidence_record_files
        FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_no_field_reuse();

      CREATE FUNCTION hm_final_delivery_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE sent handyman_final_receipt_delivery_events%ROWTYPE;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM handyman_final_receipts f WHERE f.id=NEW.receipt_id AND f.status='ISSUED'
          AND f.client_id=NEW.client_id AND f.building_id=NEW.building_id AND f.request_id=NEW.request_id
          AND f.tenant_company_id=NEW.tenant_company_id AND f.source_sha256=NEW.source_sha256 AND f.pdf_sha256=NEW.pdf_sha256
          AND NEW.document_version=1 AND (NEW.reported_occurred_at IS NULL OR NEW.reported_occurred_at>=f.issued_at))
        THEN RAISE EXCEPTION 'Delivery must bind the exact issued receipt, version, checksums and scope.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type IN ('DOWNLOADED','SENT') AND NOT hm_final_delivery_actor_valid(NEW.actor_user_id,NEW.actor_user_session_id,
          NEW.care_actor_id,NEW.care_session_id,NEW.client_id,NEW.building_id,NEW.event_type)
        THEN RAISE EXCEPTION 'Active authenticated scoped Care or Finance authority is required.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type='SENT' THEN
          IF NEW.recipient_pic_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenant_pics p WHERE p.id=NEW.recipient_pic_id
            AND p.tenant_company_id=NEW.tenant_company_id AND p.status='ACTIVE')
          THEN RAISE EXCEPTION 'Reported recipient PIC must belong to the exact tenant.' USING ERRCODE='23514'; END IF;
          IF NOT EXISTS (SELECT 1 FROM handyman_final_receipt_delivery_evidence de JOIN evidence_submissions e ON e.id=de.evidence_id
            WHERE de.evidence_id=NEW.evidence_id AND de.receipt_id=NEW.receipt_id AND e.client_id=NEW.client_id
            AND e.execution_type='HANDYMAN_FINAL_RECEIPT_DELIVERY' AND e.execution_id=NEW.receipt_id
            AND e.status='ACTIVE' AND e.retention_state<>'PURGED' AND e.content_sha256=NEW.evidence_sha256)
          THEN RAISE EXCEPTION 'SENT requires protected evidence for the exact receipt.' USING ERRCODE='23514'; END IF;
        END IF;
        IF NEW.event_type='DELIVERED' THEN
          SELECT * INTO sent FROM handyman_final_receipt_delivery_events WHERE id=NEW.sent_event_id AND event_type='SENT';
          IF NOT FOUND OR sent.receipt_id<>NEW.receipt_id OR sent.document_version<>NEW.document_version
            OR sent.client_id<>NEW.client_id OR sent.building_id<>NEW.building_id OR sent.request_id<>NEW.request_id
            OR sent.tenant_company_id<>NEW.tenant_company_id OR sent.source_sha256<>NEW.source_sha256 OR sent.pdf_sha256<>NEW.pdf_sha256
            OR sent.channel<>NEW.channel OR sent.recipient_name<>NEW.recipient_name
            OR sent.recipient_contact IS DISTINCT FROM NEW.recipient_contact OR sent.recipient_pic_id IS DISTINCT FROM NEW.recipient_pic_id
          THEN RAISE EXCEPTION 'Acknowledgment must bind the exact SENT and receipt.' USING ERRCODE='23514'; END IF;
          IF NOT EXISTS (SELECT 1 FROM tenant_pics p JOIN users u ON u.id=p.user_id AND u.status='ACTIVE'
            JOIN user_sessions s ON s.user_id=u.id AND s.id=NEW.actor_user_session_id AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
            JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=NEW.building_id AND a.status='ACTIVE'
            JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE' JOIN properties pr ON pr.id=b.property_id AND pr.client_id=NEW.client_id
            WHERE p.id=sent.recipient_pic_id AND p.tenant_company_id=NEW.tenant_company_id AND p.user_id=NEW.actor_user_id AND p.status='ACTIVE')
          THEN RAISE EXCEPTION 'DELIVERED requires the exact authenticated recipient PIC.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_final_delivery_event_insert BEFORE INSERT ON handyman_final_receipt_delivery_events
        FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_event_guard();
      CREATE FUNCTION hm_final_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Final Receipt delivery history is append-only.' USING ERRCODE='23514'; END; $$;
      CREATE TRIGGER hm_final_delivery_event_no_write BEFORE UPDATE OR DELETE ON handyman_final_receipt_delivery_events FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_immutable();
      CREATE TRIGGER hm_final_delivery_event_no_truncate BEFORE TRUNCATE ON handyman_final_receipt_delivery_events FOR EACH STATEMENT EXECUTE FUNCTION hm_final_delivery_immutable();
      CREATE TRIGGER hm_final_delivery_evidence_no_write BEFORE UPDATE OR DELETE ON handyman_final_receipt_delivery_evidence FOR EACH ROW EXECUTE FUNCTION hm_final_delivery_immutable();
      CREATE TRIGGER hm_final_delivery_evidence_no_truncate BEFORE TRUNCATE ON handyman_final_receipt_delivery_evidence FOR EACH STATEMENT EXECUTE FUNCTION hm_final_delivery_immutable();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_final_receipt_delivery_events) OR EXISTS (SELECT 1 FROM handyman_final_receipt_delivery_evidence)
        THEN RAISE EXCEPTION 'Cannot discard Final Receipt delivery history.' USING ERRCODE='23514'; END IF; END $$;
      DROP TRIGGER hm_final_delivery_field_no_reuse ON handyman_evidence_record_files;
      DROP TRIGGER hm_final_delivery_submission_owner ON evidence_submissions;
      DROP TRIGGER hm_final_delivery_submission_protect ON evidence_submissions;
      DROP TRIGGER hm_final_delivery_event_insert ON handyman_final_receipt_delivery_events;
      DROP TRIGGER hm_final_delivery_evidence_insert ON handyman_final_receipt_delivery_evidence;
      DROP FUNCTION hm_final_delivery_event_guard(),hm_final_delivery_no_field_reuse(),hm_final_delivery_submission_owner_required(),
        hm_final_delivery_submission_guard(),hm_final_delivery_evidence_guard();
      DROP TABLE handyman_final_receipt_delivery_events, handyman_final_receipt_delivery_evidence;
      DROP FUNCTION hm_final_delivery_actor_valid(uuid,uuid,uuid,uuid,uuid,uuid,text),hm_final_delivery_immutable();
      ALTER TABLE evidence_submissions DROP CONSTRAINT hm_final_delivery_evidence_metadata, DROP CONSTRAINT evidence_submission_execution,
        ADD CONSTRAINT evidence_submission_execution CHECK (execution_type IN (
          'FORM_INSTANCE','CHECKLIST_EXECUTION','WORK_ORDER','VENDOR_WORK','UTILITY_METER_READING','PERMIT',
          'FINDING','FINDING_REWORK','FINDING_VERIFICATION','HANDYMAN_REQUEST','HANDYMAN_CUSTOMER_PAYMENT','HANDYMAN_WARRANTY_COMPLAINT'));
    `);
  },
};
