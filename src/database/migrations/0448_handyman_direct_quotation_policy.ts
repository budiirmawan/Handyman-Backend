import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Additive inspection-first configuration and immutable triage provenance.
 * No historical triage, diagnosis or quotation is rewritten/grandfathered.
 */
export const migration0448HandymanDirectQuotationPolicy: Migration = {
  id: '0448_handyman_direct_quotation_policy',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE service_catalog ADD COLUMN inspection_policy TEXT NOT NULL
        DEFAULT 'INSPECTION_REQUIRED'
        CHECK (inspection_policy IN ('INSPECTION_REQUIRED', 'DIRECT_ALLOWED'));
      ALTER TABLE handyman_request_triage_decisions
        ADD COLUMN service_inspection_policy TEXT
          CHECK (service_inspection_policy IN ('INSPECTION_REQUIRED', 'DIRECT_ALLOWED')),
        ADD COLUMN policy_service_catalog_id UUID REFERENCES service_catalog(id),
        ADD COLUMN policy_catalog_updated_at TIMESTAMPTZ,
        ADD COLUMN scope_clarity_confirmed BOOLEAN,
        ADD COLUMN direct_quotation_reason TEXT;

      CREATE FUNCTION handyman_direct_triage_policy_guard() RETURNS trigger AS $$
      DECLARE r handyman_service_requests%ROWTYPE; s service_catalog%ROWTYPE;
      BEGIN
        IF NEW.triage_disposition <> 'DIAGNOSIS' THEN RETURN NEW; END IF;
        SELECT * INTO r FROM handyman_service_requests WHERE id = NEW.handyman_request_id FOR UPDATE;
        SELECT * INTO s FROM service_catalog WHERE id = r.service_catalog_id FOR SHARE;
        IF s.id IS NULL OR s.status <> 'ACTIVE' OR s.client_id <> r.client_id
          OR s.inspection_policy <> 'DIRECT_ALLOWED'
          OR NEW.service_inspection_policy IS DISTINCT FROM 'DIRECT_ALLOWED'
          OR NEW.policy_service_catalog_id IS DISTINCT FROM s.id
          OR date_trunc('milliseconds', NEW.policy_catalog_updated_at) IS DISTINCT FROM date_trunc('milliseconds', s.updated_at)
          OR NEW.scope_clarity_confirmed IS DISTINCT FROM TRUE
          OR NEW.direct_quotation_reason IS NULL
          OR char_length(btrim(NEW.direct_quotation_reason)) NOT BETWEEN 20 AND 500
          OR cardinality(regexp_split_to_array(btrim(NEW.direct_quotation_reason), '\\s+')) < 3
        THEN
          RAISE EXCEPTION 'Direct triage requires an allowed service, explicit scope clarity and reason.'
            USING ERRCODE = '23514', CONSTRAINT = 'handyman_direct_triage_policy_required';
        END IF;
        -- pg maps timestamps to JS millisecond Dates. Store the server's full
        -- precision value after checking the locked catalog snapshot.
        NEW.policy_catalog_updated_at := s.updated_at;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_direct_triage_policy_insert BEFORE INSERT ON handyman_request_triage_decisions
        FOR EACH ROW EXECUTE FUNCTION handyman_direct_triage_policy_guard();

      CREATE FUNCTION handyman_has_direct_quotation_authority(request_id UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM handyman_request_triage_decisions t
          JOIN handyman_service_requests r ON r.id = t.handyman_request_id
          WHERE r.id = request_id AND t.triage_disposition = 'DIAGNOSIS'
            AND t.client_id = r.client_id AND t.building_id = r.building_id
            AND t.service_inspection_policy = 'DIRECT_ALLOWED'
            AND t.policy_service_catalog_id = r.service_catalog_id
            AND t.policy_catalog_updated_at IS NOT NULL
            AND t.scope_clarity_confirmed IS TRUE
            AND char_length(btrim(t.direct_quotation_reason)) BETWEEN 20 AND 500
            AND cardinality(regexp_split_to_array(btrim(t.direct_quotation_reason), '\\s+')) >= 3
        )
      $$ LANGUAGE sql;

      CREATE FUNCTION handyman_direct_preparation_guard() RETURNS trigger AS $$
      DECLARE request_id UUID;
      BEGIN
        IF TG_TABLE_NAME = 'handyman_request_diagnoses' THEN
          request_id := NEW.handyman_request_id;
        ELSE
          IF NEW.status <> 'DRAFT' THEN RETURN NEW; END IF;
          SELECT handyman_request_id INTO request_id FROM handyman_quotations WHERE id = NEW.quotation_id;
        END IF;
        PERFORM 1 FROM handyman_service_requests WHERE id = request_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM handyman_request_triage_decisions
            WHERE handyman_request_id = request_id AND triage_disposition = 'INSPECTION_REQUIRED')
          AND NOT handyman_has_direct_quotation_authority(request_id)
        THEN
          RAISE EXCEPTION 'Direct preparation requires the persisted Operations policy authorization.'
            USING ERRCODE = '23514', CONSTRAINT = 'handyman_direct_preparation_authority_required';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_direct_diagnosis_insert BEFORE INSERT ON handyman_request_diagnoses
        FOR EACH ROW EXECUTE FUNCTION handyman_direct_preparation_guard();
      CREATE TRIGGER handyman_direct_draft_insert BEFORE INSERT ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION handyman_direct_preparation_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER handyman_direct_draft_insert ON handyman_quotation_versions;
      DROP TRIGGER handyman_direct_diagnosis_insert ON handyman_request_diagnoses;
      DROP FUNCTION handyman_direct_preparation_guard();
      DROP FUNCTION handyman_has_direct_quotation_authority(UUID);
      DROP TRIGGER handyman_direct_triage_policy_insert ON handyman_request_triage_decisions;
      DROP FUNCTION handyman_direct_triage_policy_guard();
      ALTER TABLE handyman_request_triage_decisions
        DROP COLUMN direct_quotation_reason, DROP COLUMN scope_clarity_confirmed,
        DROP COLUMN policy_catalog_updated_at, DROP COLUMN policy_service_catalog_id,
        DROP COLUMN service_inspection_policy;
      ALTER TABLE service_catalog DROP COLUMN inspection_policy;
    `);
  },
};
