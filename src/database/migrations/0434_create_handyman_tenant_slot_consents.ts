import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2A — BM-attested tenant slot choice.
 *
 * Unmerged on `main` (main ends at 0433), so this migration was amended in place
 * before any deployment rather than stacked as a new migration.
 *
 * 1. `handyman_handoff_integrations.tenant_slot_choice_scope` (default FALSE) is
 *    the explicit grant for a BM integration to sign TENANT_SLOT_CHOICE
 *    assertions. This migration grants no integration.
 * 2. `handyman_visit_tenant_slot_consents` is the append-only, REQUEST-level
 *    provenance of a tenant-originated slot choice. It names no appointment, so
 *    the tenant can choose before Operations matches a resource. One-time use via
 *    unique (integration, JTI) and (integration, BM evidence id).
 * 0. Corrects the 0431 capacity commit guard, which could not commit any appointment
 *    write (see the comment in up()). Same invariant, corrected evaluation.
 * 3. Insert guard: the consent must be bound to the request's stored tenant
 *    company, building and tenant PIC; at most one pending (unbound) choice per
 *    request and kind; and no TENANT_SELECTED/CONFIRMED/IN_PROGRESS visit may
 *    already exist for that kind.
 * 4. `handyman_visit_tenant_slot_bindings` is append-only. It binds one consent to
 *    one PROPOSED appointment with the exact request, kind, tenant, building and
 *    slot. Composite keys enforce request/client/kind; a guard enforces slot.
 * 5. Deferred commit guard on appointments: a TENANT_SELECTED/CONFIRMED/IN_PROGRESS/
 *    COMPLETED visit must reference the consent that is bound to it. A string
 *    evidence id alone is not consent.
 *
 * Handyman creates no consent. Rows exist only from a verified BM assertion.
 * Quotation decisions are never reused here.
 */
export const migration0434CreateHandymanTenantSlotConsents: Migration = {
  id: '0434_create_handyman_tenant_slot_consents',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_handoff_integrations
        ADD COLUMN tenant_slot_choice_scope BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE handyman_visit_tenant_slot_consents (
        id                      UUID PRIMARY KEY,
        integration_id          UUID NOT NULL REFERENCES handyman_handoff_integrations (id),
        assertion_jti           TEXT NOT NULL CHECK (char_length(btrim(assertion_jti)) BETWEEN 16 AND 128),
        bm_consent_evidence_id  TEXT NOT NULL CHECK (char_length(btrim(bm_consent_evidence_id)) BETWEEN 1 AND 128),
        tenant_user_reference   TEXT NOT NULL CHECK (char_length(btrim(tenant_user_reference)) BETWEEN 1 AND 128),
        assertion_hash          TEXT NOT NULL CHECK (assertion_hash ~ '^[0-9a-f]{64}$'),
        handyman_request_id     UUID NOT NULL,
        client_id               UUID NOT NULL REFERENCES clients (id),
        kind                    TEXT NOT NULL CHECK (kind IN ('INSPECTION', 'EXECUTION')),
        tenant_company_id       UUID NOT NULL REFERENCES tenant_companies (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        tenant_pic_id           UUID NOT NULL REFERENCES tenant_pics (id),
        tenant_building_context_id UUID NOT NULL REFERENCES tenant_building_contexts (id),
        selected_start_at       TIMESTAMPTZ NOT NULL,
        selected_end_at         TIMESTAMPTZ NOT NULL,
        method                  TEXT NOT NULL CHECK (method = 'BM_AUTHENTICATED_TENANT_SELECTION'),
        accepted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_visit_consents_window_check CHECK (selected_end_at > selected_start_at),
        CONSTRAINT handyman_visit_consents_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
          REFERENCES handyman_service_requests (id, client_id),
        CONSTRAINT handyman_visit_consents_jti_unique UNIQUE (integration_id, assertion_jti),
        CONSTRAINT handyman_visit_consents_evidence_unique UNIQUE (integration_id, bm_consent_evidence_id),
        CONSTRAINT handyman_visit_consents_binding_key
          UNIQUE (id, handyman_request_id, client_id, kind)
      );

      CREATE TABLE handyman_visit_tenant_slot_bindings (
        consent_id           UUID PRIMARY KEY,
        appointment_id       UUID NOT NULL UNIQUE,
        handyman_request_id  UUID NOT NULL,
        client_id            UUID NOT NULL,
        kind                 TEXT NOT NULL CHECK (kind IN ('INSPECTION', 'EXECUTION')),
        appointment_version  INTEGER NOT NULL CHECK (appointment_version > 0),
        bound_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_visit_bindings_consent_fk
          FOREIGN KEY (consent_id, handyman_request_id, client_id, kind)
          REFERENCES handyman_visit_tenant_slot_consents (id, handyman_request_id, client_id, kind),
        CONSTRAINT handyman_visit_bindings_appointment_fk
          FOREIGN KEY (appointment_id, client_id)
          REFERENCES handyman_visit_appointments (id, client_id)
      );
    `);

    await client.query(`
      CREATE FUNCTION handyman_visit_consent_insert_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE req RECORD;
      BEGIN
        SELECT r.client_id, r.tenant_company_id, r.building_id, r.tenant_pic_id INTO req
          FROM handyman_service_requests r WHERE r.id = NEW.handyman_request_id;
        IF NOT FOUND OR req.client_id IS DISTINCT FROM NEW.client_id
          OR req.tenant_company_id IS DISTINCT FROM NEW.tenant_company_id
          OR req.building_id IS DISTINCT FROM NEW.building_id
          OR req.tenant_pic_id IS DISTINCT FROM NEW.tenant_pic_id THEN
          RAISE EXCEPTION 'Tenant slot consent is not bound to the request tenant'
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM handyman_visit_tenant_slot_consents c
           WHERE c.handyman_request_id = NEW.handyman_request_id AND c.kind = NEW.kind
             AND NOT EXISTS (SELECT 1 FROM handyman_visit_tenant_slot_bindings b WHERE b.consent_id = c.id)
        ) THEN
          RAISE EXCEPTION 'A tenant slot choice is already pending for this visit kind'
            USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM handyman_visit_appointments a
           WHERE a.handyman_request_id = NEW.handyman_request_id AND a.kind = NEW.kind
             AND a.state IN ('TENANT_SELECTED', 'CONFIRMED', 'IN_PROGRESS')
        ) THEN
          RAISE EXCEPTION 'A selected or confirmed visit already exists for this kind'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $guard$;

      CREATE TRIGGER handyman_visit_consent_insert_guard
        BEFORE INSERT ON handyman_visit_tenant_slot_consents
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_consent_insert_guard();

      CREATE FUNCTION handyman_visit_tenant_slot_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        RAISE EXCEPTION 'Tenant slot consent and binding records are append-only'
          USING ERRCODE = '23514';
      END $guard$;

      CREATE TRIGGER handyman_visit_consents_no_update
        BEFORE UPDATE OR DELETE ON handyman_visit_tenant_slot_consents
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_tenant_slot_append_only();

      CREATE TRIGGER handyman_visit_bindings_no_update
        BEFORE UPDATE OR DELETE ON handyman_visit_tenant_slot_bindings
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_tenant_slot_append_only();
    `);

    // 0. Correction to 0431 (already on main, so not edited in place). The commit guard
    //    built `appointment_uuid` with one nested CASE expression. PL/pgSQL resolves
    //    OLD.appointment_id against the row type of the table the trigger is attached to,
    //    so on handyman_visit_appointments (which has no appointment_id) every commit that
    //    writes an appointment failed with 42703. The same invariant is kept here, with
    //    statement-level branches so OLD.appointment_id is only evaluated for reservations.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_visit_capacity_commit_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE appointment_uuid UUID; appointment_state TEXT; active_exists BOOLEAN;
      BEGIN
        IF TG_TABLE_NAME = 'handyman_visit_appointments' THEN
          appointment_uuid := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
          appointment_uuid := OLD.appointment_id;
        ELSE
          appointment_uuid := NEW.appointment_id;
        END IF;
        SELECT state INTO appointment_state
          FROM handyman_visit_appointments WHERE id = appointment_uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT EXISTS (
          SELECT 1 FROM handyman_visit_capacity_reservations
          WHERE appointment_id = appointment_uuid AND active
        ) INTO active_exists;
        IF active_exists IS DISTINCT FROM
          (appointment_state IN ('CONFIRMED','IN_PROGRESS')) THEN
          RAISE EXCEPTION 'Confirmed/in-progress visits must hold one active matching reservation'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $guard$;
    `);

    await client.query(`
      CREATE FUNCTION handyman_visit_binding_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE ap RECORD; cs RECORD;
      BEGIN
        SELECT a.state, a.version, a.kind, a.handyman_request_id, a.tenant_company_id,
               a.building_id, a.start_at, a.end_at INTO ap
          FROM handyman_visit_appointments a WHERE a.id = NEW.appointment_id;
        SELECT c.kind, c.tenant_company_id, c.building_id, c.selected_start_at, c.selected_end_at
          INTO cs FROM handyman_visit_tenant_slot_consents c WHERE c.id = NEW.consent_id;
        IF NOT FOUND OR ap.state <> 'PROPOSED' OR ap.version <> NEW.appointment_version
          OR ap.kind IS DISTINCT FROM cs.kind OR ap.kind IS DISTINCT FROM NEW.kind
          OR ap.handyman_request_id IS DISTINCT FROM NEW.handyman_request_id
          OR ap.tenant_company_id IS DISTINCT FROM cs.tenant_company_id
          OR ap.building_id IS DISTINCT FROM cs.building_id
          OR ap.start_at IS DISTINCT FROM cs.selected_start_at
          OR ap.end_at IS DISTINCT FROM cs.selected_end_at THEN
          RAISE EXCEPTION 'Tenant slot binding does not match its PROPOSED appointment'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $guard$;

      CREATE TRIGGER handyman_visit_binding_guard
        BEFORE INSERT ON handyman_visit_tenant_slot_bindings
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_binding_guard();

      CREATE FUNCTION handyman_visit_consent_commit_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        IF NEW.state IN ('TENANT_SELECTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED') AND NOT EXISTS (
          SELECT 1 FROM handyman_visit_tenant_slot_bindings b
            JOIN handyman_visit_tenant_slot_consents c ON c.id = b.consent_id
           WHERE b.appointment_id = NEW.id AND c.id::text = NEW.tenant_choice_evidence_ref
        ) THEN
          RAISE EXCEPTION 'Selected visit requires its bound tenant slot consent'
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
    // Restore the 0431 commit guard exactly as it was on main.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_visit_capacity_commit_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE appointment_uuid UUID; appointment_state TEXT; active_exists BOOLEAN;
      BEGIN
        appointment_uuid := CASE WHEN TG_TABLE_NAME = 'handyman_visit_appointments'
                                 THEN NEW.id
                                 ELSE CASE WHEN TG_OP = 'DELETE' THEN OLD.appointment_id
                                           ELSE NEW.appointment_id END END;
        SELECT state INTO appointment_state
          FROM handyman_visit_appointments WHERE id = appointment_uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT EXISTS (
          SELECT 1 FROM handyman_visit_capacity_reservations
          WHERE appointment_id = appointment_uuid AND active
        ) INTO active_exists;
        IF active_exists IS DISTINCT FROM
          (appointment_state IN ('CONFIRMED','IN_PROGRESS')) THEN
          RAISE EXCEPTION 'Confirmed/in-progress visits must hold one active matching reservation'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $guard$;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_visit_appointment_consent_commit_guard ON handyman_visit_appointments;
      DROP FUNCTION IF EXISTS handyman_visit_consent_commit_guard();
      DROP TABLE IF EXISTS handyman_visit_tenant_slot_bindings;
      DROP FUNCTION IF EXISTS handyman_visit_binding_guard();
      DROP TABLE IF EXISTS handyman_visit_tenant_slot_consents;
      DROP FUNCTION IF EXISTS handyman_visit_tenant_slot_append_only();
      DROP FUNCTION IF EXISTS handyman_visit_consent_insert_guard();
      ALTER TABLE handyman_handoff_integrations DROP COLUMN IF EXISTS tenant_slot_choice_scope;
    `);
  },
};
