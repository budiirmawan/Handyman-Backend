import type { Migration } from './types';

/** BM Care communication facts only. PIC decisions remain in the existing ledger. */
export const migration0451HandymanCareQuotationAssistance: Migration = {
  id: '0451_handyman_care_quotation_assistance',
  async up(tx) {
    await tx.query(`
      CREATE TABLE handyman_care_intake_channels (
        handyman_request_id UUID PRIMARY KEY REFERENCES handyman_service_requests(id),
        channel TEXT NOT NULL CHECK(channel IN ('WALK_IN','WHATSAPP','EMAIL','PHONE','OTHER')),
        care_actor_id UUID NOT NULL REFERENCES handyman_handoff_care_actors(id),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_care_quotation_deliveries (
        quotation_version_id UUID PRIMARY KEY REFERENCES handyman_quotation_versions(id),
        delivered_by_user_id UUID NOT NULL REFERENCES users(id),
        delivered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE handyman_care_quotation_presentations (
        id UUID PRIMARY KEY,
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        care_actor_id UUID NOT NULL REFERENCES handyman_handoff_care_actors(id),
        care_session_id UUID NOT NULL REFERENCES handyman_care_workspace_sessions(id),
        channel TEXT NOT NULL CHECK(channel IN ('WALK_IN','WHATSAPP','EMAIL','PHONE','OTHER')),
        idempotency_key UUID NOT NULL,
        presented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(care_actor_id,idempotency_key)
      );
      CREATE TABLE handyman_care_quotation_handoffs (
        id UUID PRIMARY KEY,
        presentation_id UUID NOT NULL UNIQUE REFERENCES handyman_care_quotation_presentations(id),
        quotation_version_id UUID NOT NULL REFERENCES handyman_quotation_versions(id),
        approval_binding_id UUID NOT NULL REFERENCES handyman_quotation_approval_bindings(id),
        care_actor_id UUID NOT NULL REFERENCES handyman_handoff_care_actors(id),
        care_session_id UUID NOT NULL REFERENCES handyman_care_workspace_sessions(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        expires_at TIMESTAMPTZ NOT NULL,
        CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '15 minutes')
      );
      CREATE TABLE handyman_care_quotation_pic_claims (
        handoff_id UUID PRIMARY KEY REFERENCES handyman_care_quotation_handoffs(id),
        pic_session_id UUID NOT NULL REFERENCES handyman_pic_workspace_sessions(id),
        authenticated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX handyman_care_presentation_version ON handyman_care_quotation_presentations(quotation_version_id,presented_at);
      CREATE INDEX handyman_care_handoff_version ON handyman_care_quotation_handoffs(quotation_version_id,created_at);

      CREATE FUNCTION handyman_care_quote_fact_guard() RETURNS trigger AS $$
      DECLARE version_id UUID; v handyman_quotation_versions%ROWTYPE; request handyman_service_requests%ROWTYPE;
        h handyman_care_quotation_handoffs%ROWTYPE; actor_id UUID; session_id UUID;
      BEGIN
        IF TG_TABLE_NAME='handyman_care_quotation_pic_claims' THEN
          SELECT * INTO h FROM handyman_care_quotation_handoffs WHERE id=NEW.handoff_id;
          version_id:=h.quotation_version_id;
        ELSE version_id:=NEW.quotation_version_id;
        END IF;
        SELECT * INTO v FROM handyman_quotation_versions WHERE id=version_id FOR SHARE;
        SELECT r.* INTO request FROM handyman_service_requests r JOIN handyman_quotations q ON q.handyman_request_id=r.id WHERE q.id=v.quotation_id;
        IF v.id IS NULL OR v.status<>'ISSUED' OR v.valid_until<=clock_timestamp() OR v.valid_until IS NULL THEN
          RAISE EXCEPTION 'Care assistance requires a current unexpired issued quotation.' USING ERRCODE='23514',CONSTRAINT='handyman_care_quotation_conflict';
        END IF;
        IF TG_TABLE_NAME IN ('handyman_care_quotation_presentations','handyman_care_quotation_handoffs') THEN
          actor_id:=NEW.care_actor_id; session_id:=NEW.care_session_id;
          IF NOT EXISTS(SELECT 1 FROM handyman_care_workspace_sessions s
            JOIN handyman_handoff_care_actors a ON a.id=s.care_actor_id
            JOIN handyman_handoff_integrations i ON i.id=s.integration_id AND i.id=a.integration_id
            JOIN buildings b ON b.id=request.building_id AND b.status='ACTIVE'
            JOIN handyman_care_property_grants g ON g.property_id=b.property_id AND g.care_actor_id=a.id AND g.status='ACTIVE'
            WHERE s.id=session_id AND a.id=actor_id AND a.status='ACTIVE' AND i.status='ACTIVE'
              AND i.actor_capability='CUSTOMER_CARE' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
            RAISE EXCEPTION 'Care session does not authorize this Building.' USING ERRCODE='23514',CONSTRAINT='handyman_care_quotation_conflict';
          END IF;
        END IF;
        IF TG_TABLE_NAME='handyman_care_quotation_handoffs' THEN
          IF NOT EXISTS(SELECT 1 FROM handyman_care_quotation_presentations p
            WHERE p.id=NEW.presentation_id AND p.quotation_version_id=v.id)
            OR NOT EXISTS(SELECT 1 FROM handyman_quotation_approval_bindings b WHERE b.id=NEW.approval_binding_id
              AND b.quotation_id=v.quotation_id AND b.status='ACTIVE'
              AND b.effective_from<=clock_timestamp() AND (b.effective_until IS NULL OR b.effective_until>clock_timestamp()))
            OR NEW.expires_at>v.valid_until THEN
            RAISE EXCEPTION 'Handoff must pin the presented version and current explicit binding.' USING ERRCODE='23514',CONSTRAINT='handyman_care_quotation_conflict';
          END IF;
        ELSIF TG_TABLE_NAME='handyman_care_quotation_pic_claims' THEN
          IF h.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM handyman_pic_workspace_sessions s
            JOIN handyman_quotation_approval_bindings b ON b.id=h.approval_binding_id AND b.tenant_pic_id=s.tenant_pic_id
            WHERE s.id=NEW.pic_session_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
              AND s.tenant_company_id=request.tenant_company_id AND s.building_id=request.building_id
              AND (s.space_id IS NULL OR s.space_id=request.space_id) AND s.tenant_pic_id IS NOT NULL
              AND b.status='ACTIVE' AND b.quotation_id=v.quotation_id
              AND b.effective_from<=clock_timestamp() AND (b.effective_until IS NULL OR b.effective_until>clock_timestamp())) THEN
            RAISE EXCEPTION 'Handoff needs independently authenticated bound PIC.' USING ERRCODE='23514',CONSTRAINT='handyman_care_quotation_conflict';
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
    `);
    for (const table of ['handyman_care_intake_channels','handyman_care_quotation_deliveries',
      'handyman_care_quotation_presentations','handyman_care_quotation_handoffs','handyman_care_quotation_pic_claims']) {
      await tx.query(`CREATE TRIGGER immutable_care_fact BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION handyman_prequotation_history_immutable()`);
      if (table !== 'handyman_care_intake_channels') await tx.query(`CREATE TRIGGER validate_care_fact BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION handyman_care_quote_fact_guard()`);
    }
    await tx.query(`CREATE TRIGGER prequotation_cancelled_guard BEFORE INSERT ON handyman_care_intake_channels
      FOR EACH ROW EXECUTE FUNCTION handyman_cancelled_request_write_guard()`);
  },
  async down() { throw new Error('Care quotation assistance history is forward-only; use a corrective migration.'); },
};
