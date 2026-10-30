import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Request-specific buyer facts; no new customer master and no financial writes. */
export const migration0498HandymanRequestBuyerBindings: Migration = {
  id: '0498_handyman_request_buyer_bindings',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_buyer_binding_heads (
        request_id UUID PRIMARY KEY,
        client_id UUID NOT NULL,
        building_id UUID NOT NULL,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        binding_id UUID,
        decision_id UUID,
        FOREIGN KEY (request_id,client_id,building_id)
          REFERENCES handyman_service_requests (id,client_id,building_id),
        CHECK ((version=0 AND binding_id IS NULL AND decision_id IS NULL) OR (version>0 AND binding_id IS NOT NULL))
      );
      CREATE TABLE handyman_buyer_bindings (
        id UUID PRIMARY KEY,
        request_id UUID NOT NULL,
        client_id UUID NOT NULL,
        building_id UUID NOT NULL,
        version INTEGER NOT NULL CHECK (version>0),
        previous_binding_id UUID REFERENCES handyman_buyer_bindings(id),
        buyer_tenant_company_id UUID NOT NULL,
        snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
        digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (request_id,client_id,building_id)
          REFERENCES handyman_service_requests (id,client_id,building_id),
        FOREIGN KEY (buyer_tenant_company_id,client_id) REFERENCES tenant_companies(id,client_id),
        UNIQUE (request_id,version),
        UNIQUE (request_id,previous_binding_id)
      );
      CREATE TABLE handyman_buyer_binding_decisions (
        id UUID PRIMARY KEY,
        binding_id UUID NOT NULL UNIQUE REFERENCES handyman_buyer_bindings(id),
        request_id UUID NOT NULL,
        client_id UUID NOT NULL,
        building_id UUID NOT NULL,
        binding_version INTEGER NOT NULL,
        binding_digest TEXT NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
        decision TEXT NOT NULL CHECK (decision IN ('VERIFY','REJECT')),
        evidence_source TEXT NOT NULL CHECK (char_length(btrim(evidence_source)) BETWEEN 1 AND 200
          AND evidence_source=btrim(evidence_source) AND evidence_source !~ '[\\x01-\\x1F\\x7F]'),
        evidence_reference TEXT NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500
          AND evidence_reference=btrim(evidence_reference) AND evidence_reference !~ '[\\x01-\\x1F\\x7F]'),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        decision_digest TEXT NOT NULL CHECK (decision_digest ~ '^[0-9a-f]{64}$'),
        FOREIGN KEY (request_id,client_id,building_id)
          REFERENCES handyman_service_requests(id,client_id,building_id)
      );
      ALTER TABLE handyman_buyer_binding_heads
        ADD FOREIGN KEY (binding_id) REFERENCES handyman_buyer_bindings(id),
        ADD FOREIGN KEY (decision_id) REFERENCES handyman_buyer_binding_decisions(id);
      CREATE INDEX hm_buyer_binding_client_idx ON handyman_buyer_bindings(client_id,building_id,request_id);

      -- All V1 values are scalars: sorted UTF-8 JSON matches shared stableJson.
      CREATE FUNCTION hm_buyer_binding_digest(payload JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT encode(digest(convert_to('{' || COALESCE((
          SELECT string_agg(to_json(k)::text || ':' || v::text, ',' ORDER BY k COLLATE "C")
          FROM jsonb_each(payload) AS x(k,v)
        ),'') || '}', 'UTF8'),'sha256'),'hex')
      $$;
      CREATE FUNCTION hm_buyer_actor_allowed(actor UUID, target_client UUID, target_building UUID, capability TEXT)
      RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1 FROM users u
          JOIN user_building_assignments uba ON uba.user_id=u.id AND uba.status='ACTIVE'
          JOIN buildings b ON b.id=uba.building_id AND b.status='ACTIVE'
          JOIN properties p ON p.id=b.property_id AND p.status='ACTIVE'
          JOIN clients c ON c.id=p.client_id AND c.status='ACTIVE'
          JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
          JOIN roles r ON r.id=ura.role_id AND r.status='ACTIVE'
          JOIN role_permission_assignments rpa ON rpa.role_id=r.id AND rpa.status='ACTIVE'
          JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE'
          WHERE u.id=actor AND u.status='ACTIVE' AND b.id=target_building AND c.id=target_client AND perm.code=capability
        )
      $$;
      CREATE FUNCTION hm_buyer_facts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Buyer binding facts and decisions are immutable.' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER hm_buyer_binding_immutable BEFORE UPDATE OR DELETE ON handyman_buyer_bindings
        FOR EACH ROW EXECUTE FUNCTION hm_buyer_facts_immutable();
      CREATE TRIGGER hm_buyer_decision_immutable BEFORE UPDATE OR DELETE ON handyman_buyer_binding_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_buyer_facts_immutable();
      CREATE FUNCTION hm_buyer_binding_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_buyer_binding_heads%ROWTYPE; req handyman_service_requests%ROWTYPE; party tenant_companies%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT * INTO req FROM handyman_service_requests WHERE id=NEW.request_id AND client_id=NEW.client_id AND building_id=NEW.building_id;
        SELECT * INTO party FROM tenant_companies WHERE id=NEW.buyer_tenant_company_id AND client_id=NEW.client_id FOR SHARE;
        IF h.request_id IS NULL OR req.id IS NULL OR party.id IS NULL
           OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id
           OR NEW.version<>h.version+1 OR NEW.previous_binding_id IS DISTINCT FROM h.binding_id
           OR NOT hm_buyer_actor_allowed(NEW.created_by_user_id,NEW.client_id,NEW.building_id,'handyman.finance.manage')
           OR party.status<>'ACTIVE' OR party.verification_status<>'VERIFIED'
           OR EXISTS (SELECT 1 FROM handyman_bm_legal_counterparties bm WHERE bm.id=party.id AND bm.client_id=NEW.client_id)
           OR (party.party_kind='LEGAL_ENTITY' AND (party.legal_name IS NULL OR length(btrim(party.legal_name))=0))
           OR (party.party_kind='INDIVIDUAL' AND length(btrim(party.tenant_name))=0)
           OR NOT EXISTS (SELECT 1 FROM tenant_companies rt WHERE rt.id=req.tenant_company_id AND rt.client_id=NEW.client_id AND rt.status='ACTIVE')
           OR (req.space_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces s JOIN rooms rm ON rm.id=s.room_id
             JOIN areas ar ON ar.id=rm.area_id JOIN floors fl ON fl.id=ar.floor_id
             WHERE s.id=req.space_id AND s.status='ACTIVE' AND fl.building_id=NEW.building_id))
           OR (party.id<>req.tenant_company_id AND NOT EXISTS (
              SELECT 1 FROM unit_party_roles ur WHERE ur.client_id=NEW.client_id AND ur.building_id=NEW.building_id
                AND ur.space_id=req.space_id AND ur.tenant_company_id=party.id AND ur.status='ACTIVE'
                AND ur.effective_from<=clock_timestamp() AND (ur.effective_until IS NULL OR ur.effective_until>clock_timestamp())
                AND (ur.party_role IN ('OWNER','OCCUPANT') OR (ur.party_role='PIC' AND EXISTS (
                  SELECT 1 FROM handyman_request_parties rp WHERE rp.request_id=req.id AND rp.party_role='COST_RESPONSIBILITY' AND rp.tenant_company_id=party.id)))
           ))
           OR EXISTS (SELECT 1 FROM handyman_request_parties rp WHERE rp.request_id=req.id
             AND rp.party_role='COST_RESPONSIBILITY' AND rp.tenant_company_id<>party.id)
           OR NEW.snapshot->>'schema' IS DISTINCT FROM 'HANDYMAN_BUYER_BINDING_V1'
           OR NEW.snapshot->>'id' IS DISTINCT FROM NEW.id::text
           OR NEW.snapshot->>'requestId' IS DISTINCT FROM NEW.request_id::text
           OR NEW.snapshot->>'clientId' IS DISTINCT FROM NEW.client_id::text
           OR NEW.snapshot->>'buildingId' IS DISTINCT FROM NEW.building_id::text
           OR NEW.snapshot->>'buyerTenantCompanyId' IS DISTINCT FROM party.id::text
           OR NEW.snapshot->>'buyerKind' IS DISTINCT FROM party.party_kind
           OR NEW.snapshot->>'buyerLegalName' IS DISTINCT FROM (CASE WHEN party.party_kind='INDIVIDUAL' THEN party.tenant_name ELSE party.legal_name END)
           OR NEW.snapshot->>'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text
           OR (NEW.snapshot->>'version') IS DISTINCT FROM NEW.version::text
           OR NEW.snapshot->>'consentAuthority' IS DISTINCT FROM 'NOT_ASSERTED'
           OR NOT COALESCE(char_length(btrim(NEW.snapshot->>'evidenceSource')) BETWEEN 1 AND 200
             AND NEW.snapshot->>'evidenceSource'=btrim(NEW.snapshot->>'evidenceSource') AND NEW.snapshot->>'evidenceSource' !~ '[\\x01-\\x1F\\x7F]',false)
           OR NOT COALESCE(char_length(btrim(NEW.snapshot->>'evidenceReference')) BETWEEN 1 AND 500
             AND NEW.snapshot->>'evidenceReference'=btrim(NEW.snapshot->>'evidenceReference') AND NEW.snapshot->>'evidenceReference' !~ '[\\x01-\\x1F\\x7F]',false)
           OR NEW.digest IS DISTINCT FROM hm_buyer_binding_digest(NEW.snapshot) THEN
          RAISE EXCEPTION 'Buyer binding requires an exact authorized verified request party.' USING ERRCODE='23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond';
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_buyer_binding_insert_guard BEFORE INSERT ON handyman_buyer_bindings
        FOR EACH ROW EXECUTE FUNCTION hm_buyer_binding_insert_guard();
      CREATE FUNCTION hm_buyer_decision_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_buyer_binding_heads%ROWTYPE; b handyman_buyer_bindings%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT * INTO b FROM handyman_buyer_bindings WHERE id=NEW.binding_id;
        IF h.binding_id IS DISTINCT FROM NEW.binding_id OR h.decision_id IS NOT NULL OR b.id IS NULL
           OR h.client_id<>NEW.client_id OR h.building_id<>NEW.building_id
           OR b.request_id<>NEW.request_id OR b.client_id<>NEW.client_id OR b.building_id<>NEW.building_id
           OR b.version<>NEW.binding_version OR h.version<>NEW.binding_version
           OR b.digest<>NEW.binding_digest OR b.digest<>hm_buyer_binding_digest(b.snapshot)
           OR b.created_by_user_id=NEW.actor_user_id
           OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.finance.read')
           OR NOT hm_buyer_actor_allowed(NEW.actor_user_id,NEW.client_id,NEW.building_id,'handyman.tax_identity.approve') THEN
          RAISE EXCEPTION 'Buyer verification requires an independent authorized checker of the exact current binding.' USING ERRCODE='23514';
        END IF;
        NEW.occurred_at := GREATEST(date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond', b.created_at + interval '1 millisecond');
        NEW.decision_digest := hm_buyer_binding_digest(jsonb_build_object(
          'id',NEW.id::text,'bindingId',NEW.binding_id::text,'requestId',NEW.request_id::text,'clientId',NEW.client_id::text,
          'buildingId',NEW.building_id::text,'bindingVersion',NEW.binding_version,'bindingDigest',NEW.binding_digest,
          'decision',NEW.decision,'evidenceSource',NEW.evidence_source,'evidenceReference',NEW.evidence_reference,
          'actorUserId',NEW.actor_user_id::text,'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ));
        RETURN NEW;
      END $$;
      CREATE TRIGGER hm_buyer_decision_insert_guard BEFORE INSERT ON handyman_buyer_binding_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_buyer_decision_insert_guard();
      CREATE FUNCTION hm_buyer_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Buyer head cannot be deleted.' USING ERRCODE='23514'; END IF;
        IF TG_OP='INSERT' THEN
          IF NEW.version<>0 OR NEW.binding_id IS NOT NULL OR NEW.decision_id IS NOT NULL THEN
            RAISE EXCEPTION 'Buyer head must start empty.' USING ERRCODE='23514'; END IF;
          RETURN NEW;
        END IF;
        IF NEW.request_id<>OLD.request_id OR NEW.client_id<>OLD.client_id OR NEW.building_id<>OLD.building_id THEN
          RAISE EXCEPTION 'Buyer head scope cannot change.' USING ERRCODE='23514';
        END IF;
        IF NEW.version=OLD.version+1 AND NEW.decision_id IS NULL AND EXISTS (
          SELECT 1 FROM handyman_buyer_bindings b WHERE b.id=NEW.binding_id AND b.request_id=NEW.request_id
            AND b.client_id=NEW.client_id AND b.building_id=NEW.building_id AND b.version=NEW.version
            AND b.previous_binding_id IS NOT DISTINCT FROM OLD.binding_id
        ) THEN RETURN NEW; END IF;
        IF NEW.version=OLD.version AND NEW.binding_id=OLD.binding_id AND OLD.decision_id IS NULL AND EXISTS (
          SELECT 1 FROM handyman_buyer_binding_decisions d WHERE d.id=NEW.decision_id AND d.binding_id=NEW.binding_id
            AND d.request_id=NEW.request_id AND d.client_id=NEW.client_id AND d.building_id=NEW.building_id
        ) THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Invalid buyer head transition.' USING ERRCODE='23514';
      END $$;
      CREATE TRIGGER hm_buyer_head_guard BEFORE INSERT OR UPDATE OR DELETE ON handyman_buyer_binding_heads
        FOR EACH ROW EXECUTE FUNCTION hm_buyer_head_guard();
      CREATE FUNCTION hm_buyer_head_must_advance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE h handyman_buyer_binding_heads%ROWTYPE;
      BEGIN
        SELECT * INTO h FROM handyman_buyer_binding_heads WHERE request_id=NEW.request_id;
        IF TG_TABLE_NAME='handyman_buyer_bindings' THEN
          IF h.binding_id IS DISTINCT FROM NEW.id OR h.version<>NEW.version THEN
            RAISE EXCEPTION 'Buyer binding must advance its head.' USING ERRCODE='23514';
          END IF;
        ELSIF TG_TABLE_NAME='handyman_buyer_binding_decisions' THEN
          IF h.decision_id IS DISTINCT FROM NEW.id THEN
            RAISE EXCEPTION 'Buyer decision must advance its head.' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER hm_buyer_binding_head_required AFTER INSERT ON handyman_buyer_bindings
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_buyer_head_must_advance();
      CREATE CONSTRAINT TRIGGER hm_buyer_decision_head_required AFTER INSERT ON handyman_buyer_binding_decisions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hm_buyer_head_must_advance();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    const rows = await tx.query(`SELECT EXISTS(SELECT 1 FROM handyman_buyer_binding_heads) AS used`);
    if (rows.rows[0].used) throw new Error('Refusing to remove populated buyer binding history.');
    await tx.query(`
      DROP TABLE handyman_buyer_binding_heads;
      DROP TABLE handyman_buyer_binding_decisions;
      DROP TABLE handyman_buyer_bindings;
      DROP FUNCTION hm_buyer_head_must_advance();
      DROP FUNCTION hm_buyer_head_guard();
      DROP FUNCTION hm_buyer_decision_insert_guard();
      DROP FUNCTION hm_buyer_binding_insert_guard();
      DROP FUNCTION hm_buyer_facts_immutable();
      DROP FUNCTION hm_buyer_actor_allowed(UUID,UUID,UUID,TEXT);
      DROP FUNCTION hm_buyer_binding_digest(JSONB);
    `);
  },
};
