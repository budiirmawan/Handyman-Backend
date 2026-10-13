import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — BM-attested tenant slot consent.
 *
 * 1. `handyman_handoff_integrations.tenant_slot_choice_scope` (default FALSE)
 *    is the explicit, fail-closed authority grant for a BM integration to sign
 *    TENANT_SLOT_CHOICE assertions. No row is granted by this migration.
 * 2. `handyman_visit_tenant_slot_consents` is the append-only provenance of a
 *    verified tenant slot choice. Exactly one consent per appointment, one per
 *    assertion JTI and one per BM evidence id per integration (one-time use).
 * 3. Deferred guards: a consent must match its appointment's exact request,
 *    tenant, building, kind, version (PROPOSED) and slot at insert; and any
 *    TENANT_SELECTED/CONFIRMED appointment must reference an existing consent.
 *
 * Handyman does not create consent. A row exists only after a verified BM
 * assertion. Quotation decisions are never reused here.
 */
export const migration0434CreateHandymanTenantSlotConsents: Migration = {
  id: '0434_create_handyman_tenant_slot_consents',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_handoff_integrations
        ADD COLUMN tenant_slot_choice_scope BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE handyman_visit_tenant_slot_consents (
        id                         UUID PRIMARY KEY,
        integration_id             UUID NOT NULL REFERENCES handyman_handoff_integrations (id),
        assertion_jti              TEXT NOT NULL CHECK (char_length(btrim(assertion_jti)) BETWEEN 16 AND 128),
        bm_consent_evidence_id     TEXT NOT NULL CHECK (char_length(btrim(bm_consent_evidence_id)) BETWEEN 1 AND 128),
        bm_user_reference          TEXT NOT NULL CHECK (char_length(btrim(bm_user_reference)) BETWEEN 1 AND 128),
        assertion_hash             TEXT NOT NULL CHECK (assertion_hash ~ '^[0-9a-f]{64}$'),
        client_id                  UUID NOT NULL REFERENCES clients (id),
        handyman_request_id        UUID NOT NULL,
        appointment_id             UUID NOT NULL REFERENCES handyman_visit_appointments (id),
        appointment_version        INTEGER NOT NULL CHECK (appointment_version > 0),
        kind                       TEXT NOT NULL CHECK (kind IN ('INSPECTION', 'EXECUTION')),
        tenant_company_id          UUID NOT NULL REFERENCES tenant_companies (id),
        building_id                UUID NOT NULL REFERENCES buildings (id),
        tenant_pic_id              UUID NOT NULL REFERENCES tenant_pics (id),
        tenant_building_context_id UUID NOT NULL REFERENCES tenant_building_contexts (id),
        selected_start_at          TIMESTAMPTZ NOT NULL,
        selected_end_at            TIMESTAMPTZ NOT NULL,
        method                     TEXT NOT NULL CHECK (method = 'BM_AUTHENTICATED_TENANT_SELECTION'),
        accepted_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_visit_consents_window_check CHECK (selected_end_at > selected_start_at),
        CONSTRAINT handyman_visit_consents_appointment_scope_fk
          FOREIGN KEY (appointment_id, client_id)
          REFERENCES handyman_visit_appointments (id, client_id),
        CONSTRAINT handyman_visit_consents_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
          REFERENCES handyman_service_requests (id, client_id),
        CONSTRAINT handyman_visit_consents_jti_unique UNIQUE (integration_id, assertion_jti),
        CONSTRAINT handyman_visit_consents_evidence_unique UNIQUE (integration_id, bm_consent_evidence_id),
        CONSTRAINT handyman_visit_consents_one_per_appointment UNIQUE (appointment_id)
      );
    `);

    await client.query(`
      CREATE FUNCTION handyman_visit_consent_insert_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE expected RECORD;
      BEGIN
        SELECT a.client_id, a.handyman_request_id, a.tenant_company_id, a.building_id,
               a.kind, a.state, a.version, a.start_at, a.end_at INTO expected
          FROM handyman_visit_appointments a WHERE a.id = NEW.appointment_id;
        IF NOT FOUND OR expected.state <> 'PROPOSED'
          OR expected.version <> NEW.appointment_version
          OR expected.client_id IS DISTINCT FROM NEW.client_id
          OR expected.handyman_request_id IS DISTINCT FROM NEW.handyman_request_id
          OR expected.tenant_company_id IS DISTINCT FROM NEW.tenant_company_id
          OR expected.building_id IS DISTINCT FROM NEW.building_id
          OR expected.kind IS DISTINCT FROM NEW.kind
          OR expected.start_at IS DISTINCT FROM NEW.selected_start_at
          OR expected.end_at IS DISTINCT FROM NEW.selected_end_at THEN
          RAISE EXCEPTION 'Tenant slot consent does not match its PROPOSED appointment'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $guard$;

      CREATE TRIGGER handyman_visit_consent_insert_guard
        BEFORE INSERT ON handyman_visit_tenant_slot_consents
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_consent_insert_guard();

      CREATE FUNCTION handyman_visit_consents_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        RAISE EXCEPTION 'Tenant slot consents are append-only' USING ERRCODE = '23514';
      END $guard$;

      CREATE TRIGGER handyman_visit_consents_no_update
        BEFORE UPDATE OR DELETE ON handyman_visit_tenant_slot_consents
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_consents_append_only();
    `);

    await client.query(`
      CREATE FUNCTION handyman_visit_consent_commit_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        IF NEW.state IN ('TENANT_SELECTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED') AND NOT EXISTS (
          SELECT 1 FROM handyman_visit_tenant_slot_consents c
          WHERE c.appointment_id = NEW.id AND c.id::text = NEW.tenant_choice_evidence_ref
        ) THEN
          RAISE EXCEPTION 'Selected visit requires its matching tenant slot consent'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $guard$;

      CREATE CONSTRAINT TRIGGER handyman_visit_appointment_consent_commit_guard
        AFTER INSERT OR UPDATE ON handyman_visit_appointments
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION handyman_visit_consent_commit_guard();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_visit_appointment_consent_commit_guard ON handyman_visit_appointments;
      DROP FUNCTION IF EXISTS handyman_visit_consent_commit_guard();
      DROP TABLE IF EXISTS handyman_visit_tenant_slot_consents;
      DROP FUNCTION IF EXISTS handyman_visit_consents_append_only();
      DROP FUNCTION IF EXISTS handyman_visit_consent_insert_guard();
      ALTER TABLE handyman_handoff_integrations DROP COLUMN IF EXISTS tenant_slot_choice_scope;
    `);
  },
};
