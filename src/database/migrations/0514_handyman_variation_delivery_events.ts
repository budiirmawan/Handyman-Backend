import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Manual Care delivery facts, not messages, tenant decisions or execution authority. */
export const migration0514HandymanVariationDeliveryEvents: Migration = {
  id: '0514_handyman_variation_delivery_events',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_variation_delivery_events (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        variation_id UUID NOT NULL REFERENCES handyman_scope_variations(id),
        offer_document_id UUID NOT NULL REFERENCES handyman_variation_offer_documents(id),
        offer_version INTEGER NOT NULL CHECK (offer_version > 0),
        revised_quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        pdf_sha256 TEXT NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
        event_type TEXT NOT NULL CHECK (event_type IN ('SENT','DELIVERED')),
        channel TEXT NOT NULL CHECK (channel IN ('WHATSAPP','EMAIL','DIRECT')),
        recipient_name TEXT NOT NULL CHECK (length(btrim(recipient_name)) BETWEEN 1 AND 200),
        recipient_contact TEXT CHECK (recipient_contact IS NULL OR length(btrim(recipient_contact)) BETWEEN 1 AND 200),
        recipient_pic_id UUID REFERENCES tenant_pics(id),
        sent_event_id UUID REFERENCES handyman_variation_delivery_events(id),
        evidence_id UUID REFERENCES evidence_submissions(id),
        evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
        evidence_kind TEXT CHECK (evidence_kind IN ('PROVIDER_RECEIPT','TENANT_ACKNOWLEDGEMENT')),
        recorded_by_user_id UUID REFERENCES users(id),
        recorded_by_care_actor_id UUID REFERENCES handyman_handoff_care_actors(id),
        idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
        reported_occurred_at TIMESTAMPTZ,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (reported_occurred_at IS NULL OR reported_occurred_at<=recorded_at),
        CHECK (num_nonnulls(recorded_by_user_id,recorded_by_care_actor_id)=1),
        CHECK ((evidence_id IS NULL) = (evidence_sha256 IS NULL)),
        CHECK (channel='DIRECT' OR recipient_contact IS NOT NULL),
        CHECK ((event_type='SENT' AND sent_event_id IS NULL AND evidence_kind IS NULL)
          OR (event_type='DELIVERED' AND sent_event_id IS NOT NULL AND evidence_id IS NOT NULL AND evidence_kind IS NOT NULL))
      );
      CREATE INDEX hm_variation_delivery_history ON handyman_variation_delivery_events
        (client_id,request_id,variation_id,offer_document_id,recorded_at,id);
      CREATE UNIQUE INDEX hm_variation_delivery_local_key ON handyman_variation_delivery_events(recorded_by_user_id,idempotency_key)
        WHERE recorded_by_user_id IS NOT NULL;
      CREATE UNIQUE INDEX hm_variation_delivery_care_key ON handyman_variation_delivery_events(recorded_by_care_actor_id,idempotency_key)
        WHERE recorded_by_care_actor_id IS NOT NULL;
      CREATE UNIQUE INDEX hm_variation_delivery_one_confirmation ON handyman_variation_delivery_events(sent_event_id)
        WHERE event_type='DELIVERED';

      CREATE FUNCTION hm_variation_delivery_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE sent handyman_variation_delivery_events%ROWTYPE;
      BEGIN
        -- Hold both lifecycle rows while recording a send, so decision or
        -- supersession cannot race the exact offered version.
        PERFORM 1 FROM handyman_variation_offer_documents d
          JOIN handyman_scope_variations v ON v.id=d.variation_id AND v.execution_scope_id=d.execution_scope_id
            AND v.client_id=d.client_id AND v.handyman_request_id=d.request_id
            AND v.revised_quotation_version_id=d.revised_quotation_version_id
          JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id AND s.client_id=v.client_id
            AND s.handyman_request_id=v.handyman_request_id
          JOIN handyman_quotation_versions qv ON qv.id=d.revised_quotation_version_id AND qv.quotation_id=s.quotation_id
          JOIN handyman_service_requests r ON r.id=d.request_id AND r.client_id=d.client_id
          WHERE d.id=NEW.offer_document_id AND d.client_id=NEW.client_id AND d.request_id=NEW.request_id
            AND d.execution_scope_id=NEW.execution_scope_id AND d.variation_id=NEW.variation_id
            AND d.variation_version=NEW.offer_version AND d.revised_quotation_version_id=NEW.revised_quotation_version_id
            AND d.pdf_sha256=NEW.pdf_sha256 AND r.building_id=NEW.building_id AND r.tenant_company_id=NEW.tenant_company_id
            AND v.building_id=NEW.building_id AND v.tenant_company_id=NEW.tenant_company_id
            AND qv.status<>'DRAFT' AND (NEW.reported_occurred_at IS NULL OR NEW.reported_occurred_at>=d.issued_at)
            AND (NEW.event_type<>'SENT' OR (v.status='REVISED_QUOTATION' AND v.tenant_decision_outcome IS NULL
              AND qv.status='ISSUED' AND qv.valid_until>clock_timestamp()))
          FOR SHARE OF v,qv;
        IF NOT FOUND THEN RAISE EXCEPTION 'Variation delivery must bind the exact official offer, version, request and checksum.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type='SENT' AND NEW.recipient_pic_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM tenant_pics p WHERE p.id=NEW.recipient_pic_id AND p.tenant_company_id=NEW.tenant_company_id AND p.status='ACTIVE'
        ) THEN RAISE EXCEPTION 'Variation recipient PIC must belong to the tenant.' USING ERRCODE='23514'; END IF;
        IF NEW.evidence_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM evidence_submissions e WHERE e.id=NEW.evidence_id AND e.client_id=NEW.client_id
            AND e.execution_type='HANDYMAN_REQUEST' AND e.execution_id=NEW.request_id AND e.status='ACTIVE' AND e.retention_state<>'PURGED'
            AND e.file_reference='evidence/' || e.id::text AND e.file_size>0
            AND e.hash_algorithm='SHA-256' AND e.content_sha256=NEW.evidence_sha256 AND e.content_hashed_at IS NOT NULL
        ) THEN RAISE EXCEPTION 'Delivery evidence must be protected, hashed, active and request-owned.' USING ERRCODE='23514'; END IF;
        IF NEW.event_type='DELIVERED' THEN
          SELECT * INTO sent FROM handyman_variation_delivery_events WHERE id=NEW.sent_event_id AND event_type='SENT';
          IF NOT FOUND OR sent.client_id<>NEW.client_id OR sent.request_id<>NEW.request_id OR sent.building_id<>NEW.building_id
            OR sent.tenant_company_id<>NEW.tenant_company_id OR sent.execution_scope_id<>NEW.execution_scope_id
            OR sent.variation_id<>NEW.variation_id OR sent.offer_document_id<>NEW.offer_document_id
            OR sent.offer_version<>NEW.offer_version OR sent.revised_quotation_version_id<>NEW.revised_quotation_version_id
            OR sent.pdf_sha256<>NEW.pdf_sha256 OR sent.channel<>NEW.channel OR sent.recipient_name<>NEW.recipient_name
            OR sent.recipient_contact IS DISTINCT FROM NEW.recipient_contact OR sent.recipient_pic_id IS DISTINCT FROM NEW.recipient_pic_id
            OR (sent.reported_occurred_at IS NOT NULL AND NEW.reported_occurred_at IS NOT NULL AND NEW.reported_occurred_at<sent.reported_occurred_at)
            OR NOT ((sent.recorded_by_user_id IS NOT NULL AND NEW.recorded_by_user_id IS NOT NULL AND sent.recorded_by_user_id<>NEW.recorded_by_user_id)
              OR (sent.recorded_by_care_actor_id IS NOT NULL AND NEW.recorded_by_care_actor_id IS NOT NULL AND sent.recorded_by_care_actor_id<>NEW.recorded_by_care_actor_id))
          THEN RAISE EXCEPTION 'Delivery confirmation must independently review the exact SENT fact.' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_variation_delivery_binding BEFORE INSERT ON handyman_variation_delivery_events
        FOR EACH ROW EXECUTE FUNCTION hm_variation_delivery_binding();
      CREATE FUNCTION hm_variation_delivery_no_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_variation_delivery_events) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Variation delivery events are append-only.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_variation_delivery_no_write BEFORE UPDATE OR DELETE ON handyman_variation_delivery_events
        FOR EACH ROW EXECUTE FUNCTION hm_variation_delivery_no_write();
      CREATE TRIGGER hm_variation_delivery_no_truncate BEFORE TRUNCATE ON handyman_variation_delivery_events
        FOR EACH STATEMENT EXECUTE FUNCTION hm_variation_delivery_no_write();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      LOCK TABLE handyman_variation_delivery_events IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_variation_delivery_events) THEN
        RAISE EXCEPTION 'Cannot discard variation delivery history.'; END IF; END; $$;
      DROP TABLE handyman_variation_delivery_events;
      DROP FUNCTION hm_variation_delivery_binding();
      DROP FUNCTION hm_variation_delivery_no_write();
    `);
  },
};
