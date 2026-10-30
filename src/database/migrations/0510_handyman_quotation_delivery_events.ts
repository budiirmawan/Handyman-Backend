import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Manual Care delivery is a journal, not a quotation decision or a messaging API. */
export const migration0510HandymanQuotationDeliveryEvents: Migration = {
  id: '0510_handyman_quotation_delivery_events',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_quotation_delivery_events (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        quotation_id UUID NOT NULL REFERENCES handyman_quotations(id),
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        document_id UUID NOT NULL REFERENCES handyman_quotation_documents(id),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        event_type TEXT NOT NULL CHECK (event_type IN ('DOWNLOADED','SENT','DELIVERED')),
        channel TEXT CHECK (channel IN ('WHATSAPP','EMAIL','DIRECT')),
        recipient_name TEXT CHECK (recipient_name IS NULL OR length(btrim(recipient_name)) BETWEEN 1 AND 200),
        recipient_contact TEXT CHECK (recipient_contact IS NULL OR length(btrim(recipient_contact)) BETWEEN 1 AND 200),
        recipient_pic_id UUID REFERENCES tenant_pics(id),
        sent_event_id UUID REFERENCES handyman_quotation_delivery_events(id),
        evidence_id UUID REFERENCES evidence_submissions(id),
        evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
        evidence_kind TEXT CHECK (evidence_kind IN ('PROVIDER_RECEIPT','TENANT_ACKNOWLEDGEMENT')),
        recorded_by_user_id UUID REFERENCES users(id),
        recorded_by_care_actor_id UUID REFERENCES handyman_handoff_care_actors(id),
        idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
        reported_occurred_at TIMESTAMPTZ,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (reported_occurred_at IS NULL OR reported_occurred_at<=recorded_at),
        CHECK (num_nonnulls(recorded_by_user_id,recorded_by_care_actor_id)=1),
        CHECK ((evidence_id IS NULL) = (evidence_sha256 IS NULL)),
        CHECK (
          (event_type='DOWNLOADED' AND channel IS NULL AND recipient_name IS NULL AND recipient_contact IS NULL
            AND recipient_pic_id IS NULL AND sent_event_id IS NULL AND evidence_id IS NULL AND evidence_kind IS NULL
            AND idempotency_key IS NULL AND payload_sha256 IS NULL AND reported_occurred_at IS NULL)
          OR
          (event_type='SENT' AND channel IS NOT NULL AND recipient_name IS NOT NULL
            AND (channel='DIRECT' OR recipient_contact IS NOT NULL) AND sent_event_id IS NULL AND evidence_kind IS NULL
            AND idempotency_key IS NOT NULL AND payload_sha256 IS NOT NULL)
          OR
          (event_type='DELIVERED' AND channel IS NOT NULL AND recipient_name IS NOT NULL
            AND (channel='DIRECT' OR recipient_contact IS NOT NULL) AND sent_event_id IS NOT NULL
            AND evidence_id IS NOT NULL AND evidence_kind IS NOT NULL AND idempotency_key IS NOT NULL AND payload_sha256 IS NOT NULL)
        )
      );
      CREATE INDEX hm_quotation_delivery_history ON handyman_quotation_delivery_events(client_id,request_id,quotation_version_id,recorded_at,id);
      CREATE UNIQUE INDEX hm_quotation_delivery_local_key ON handyman_quotation_delivery_events(recorded_by_user_id,idempotency_key)
        WHERE recorded_by_user_id IS NOT NULL AND idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX hm_quotation_delivery_care_key ON handyman_quotation_delivery_events(recorded_by_care_actor_id,idempotency_key)
        WHERE recorded_by_care_actor_id IS NOT NULL AND idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX hm_quotation_delivery_one_confirmation ON handyman_quotation_delivery_events(sent_event_id)
        WHERE event_type='DELIVERED';

      CREATE FUNCTION hm_quotation_delivery_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE sent handyman_quotation_delivery_events%ROWTYPE;
      BEGIN
        -- Lock the version so a concurrent revision/decision cannot race SENT.
        PERFORM 1 FROM handyman_quotation_documents d
          JOIN handyman_quotation_versions v ON v.id=d.quotation_version_id AND v.quotation_id=d.quotation_id
          JOIN handyman_quotations q ON q.id=d.quotation_id AND q.client_id=d.client_id AND q.handyman_request_id=d.request_id
          JOIN handyman_service_requests r ON r.id=d.request_id AND r.client_id=d.client_id
          WHERE d.id=NEW.document_id AND d.client_id=NEW.client_id AND d.request_id=NEW.request_id
            AND d.quotation_id=NEW.quotation_id AND d.quotation_version_id=NEW.quotation_version_id
            AND d.pdf_sha256=NEW.pdf_sha256 AND r.building_id=NEW.building_id AND r.tenant_company_id=NEW.tenant_company_id
            AND v.status<>'DRAFT' AND (NEW.reported_occurred_at IS NULL OR NEW.reported_occurred_at>=d.issued_at)
            AND (NEW.event_type<>'SENT' OR (v.status='ISSUED' AND v.valid_until>clock_timestamp()))
          FOR SHARE OF v;
        IF NOT FOUND THEN RAISE EXCEPTION 'Quotation delivery must bind the exact official version, request and checksum.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type='SENT' AND NEW.recipient_pic_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM tenant_pics p WHERE p.id=NEW.recipient_pic_id AND p.tenant_company_id=NEW.tenant_company_id AND p.status='ACTIVE'
        ) THEN RAISE EXCEPTION 'Quotation recipient PIC must belong to the tenant.' USING ERRCODE='23514'; END IF;
        IF NEW.evidence_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM evidence_submissions e WHERE e.id=NEW.evidence_id AND e.client_id=NEW.client_id
            AND e.execution_type='HANDYMAN_REQUEST' AND e.execution_id=NEW.request_id AND e.status='ACTIVE' AND e.retention_state<>'PURGED'
            AND e.file_reference='evidence/' || e.id::text AND e.file_size>0
            AND e.hash_algorithm='SHA-256' AND e.content_sha256=NEW.evidence_sha256 AND e.content_hashed_at IS NOT NULL
        ) THEN RAISE EXCEPTION 'Delivery evidence must be protected, hashed, active and request-owned.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type='DELIVERED' THEN
          SELECT * INTO sent FROM handyman_quotation_delivery_events WHERE id=NEW.sent_event_id AND event_type='SENT';
          IF NOT FOUND OR sent.client_id<>NEW.client_id OR sent.request_id<>NEW.request_id OR sent.building_id<>NEW.building_id
            OR sent.tenant_company_id<>NEW.tenant_company_id OR sent.document_id<>NEW.document_id
            OR sent.quotation_id<>NEW.quotation_id OR sent.quotation_version_id<>NEW.quotation_version_id
            OR sent.pdf_sha256<>NEW.pdf_sha256 OR sent.channel<>NEW.channel OR sent.recipient_name<>NEW.recipient_name
            OR sent.recipient_contact IS DISTINCT FROM NEW.recipient_contact OR sent.recipient_pic_id IS DISTINCT FROM NEW.recipient_pic_id
            OR (sent.reported_occurred_at IS NOT NULL AND NEW.reported_occurred_at IS NOT NULL AND NEW.reported_occurred_at<sent.reported_occurred_at)
            OR NOT ((sent.recorded_by_user_id IS NOT NULL AND NEW.recorded_by_user_id IS NOT NULL AND sent.recorded_by_user_id<>NEW.recorded_by_user_id)
              OR (sent.recorded_by_care_actor_id IS NOT NULL AND NEW.recorded_by_care_actor_id IS NOT NULL AND sent.recorded_by_care_actor_id<>NEW.recorded_by_care_actor_id))
          THEN RAISE EXCEPTION 'Delivery confirmation must independently review the exact SENT fact.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_quotation_delivery_binding BEFORE INSERT ON handyman_quotation_delivery_events
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_delivery_binding();
      CREATE FUNCTION hm_quotation_delivery_no_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_quotation_delivery_events) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Quotation delivery events are append-only.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_quotation_delivery_no_write BEFORE UPDATE OR DELETE ON handyman_quotation_delivery_events
        FOR EACH ROW EXECUTE FUNCTION hm_quotation_delivery_no_write();
      CREATE TRIGGER hm_quotation_delivery_no_truncate BEFORE TRUNCATE ON handyman_quotation_delivery_events
        FOR EACH STATEMENT EXECUTE FUNCTION hm_quotation_delivery_no_write();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_quotation_delivery_events) THEN
        RAISE EXCEPTION 'Cannot discard quotation delivery history.'; END IF; END; $$;
      DROP TABLE handyman_quotation_delivery_events;
      DROP FUNCTION hm_quotation_delivery_binding();
      DROP FUNCTION hm_quotation_delivery_no_write();
    `);
  },
};
