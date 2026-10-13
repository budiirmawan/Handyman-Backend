import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * Handyman E2E R1B foundation — INSPECTION and EXECUTION appointment storage.
 * The frozen CR-HM-03 final inspection row and CR-HM-05 readiness are untouched.
 * This migration is NOT an authorization/consent service and does not expose HTTP.
 * Confirming a visit is forbidden to consumers until the authenticated choice
 * and workforce/permit authority adapters are wired and independently tested.
 */
export const migration0431CreateHandymanVisitAppointments: Migration = {
  id: '0431_create_handyman_visit_appointments',
  async up(client: PoolClient): Promise<void> {
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await client.query(`
      CREATE TABLE handyman_visit_appointments (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        handyman_request_id UUID NOT NULL,
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        kind TEXT NOT NULL CHECK (kind IN ('INSPECTION', 'EXECUTION')),
        execution_scope_id UUID REFERENCES handyman_execution_scopes(id),
        resource_type TEXT NOT NULL CHECK (resource_type IN ('INSPECTOR_USER', 'CREW')),
        resource_id UUID NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ NOT NULL,
        timezone TEXT NOT NULL CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 80),
        state TEXT NOT NULL DEFAULT 'PROPOSED' CHECK
          (state IN ('PROPOSED', 'TENANT_SELECTED', 'CONFIRMED',
                     'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
        tenant_choice_evidence_ref TEXT,
        confirmed_by_user_id UUID REFERENCES users(id),
        confirmed_at TIMESTAMPTZ,
        cancelled_by_user_id UUID REFERENCES users(id),
        cancelled_at TIMESTAMPTZ,
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        supersedes_appointment_id UUID REFERENCES handyman_visit_appointments(id),
        CONSTRAINT handyman_visit_appointments_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
          REFERENCES handyman_service_requests(id, client_id),
        CONSTRAINT handyman_visit_appointments_id_client_unique UNIQUE(id, client_id),
        CONSTRAINT handyman_visit_appointments_window_check CHECK (end_at > start_at),
        CONSTRAINT handyman_visit_appointments_kind_scope_check CHECK
          ((kind = 'INSPECTION' AND execution_scope_id IS NULL AND resource_type = 'INSPECTOR_USER')
           OR (kind = 'EXECUTION' AND execution_scope_id IS NOT NULL AND resource_type = 'CREW')),
        CONSTRAINT handyman_visit_appointments_no_self_supersede CHECK
          (supersedes_appointment_id IS NULL OR supersedes_appointment_id <> id),
        CONSTRAINT handyman_visit_appointments_confirm_proof_check CHECK
          (state NOT IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED') OR
           (tenant_choice_evidence_ref IS NOT NULL AND
            char_length(btrim(tenant_choice_evidence_ref)) BETWEEN 1 AND 200 AND
            confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)),
        CONSTRAINT handyman_visit_appointments_cancel_check CHECK
          (state <> 'CANCELLED' OR cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL)
      );
      CREATE INDEX handyman_visit_appointments_request_idx
        ON handyman_visit_appointments(client_id, handyman_request_id, kind, created_at DESC);
      CREATE INDEX handyman_visit_appointments_resource_idx
        ON handyman_visit_appointments(client_id, resource_type, resource_id, start_at);
      CREATE UNIQUE INDEX handyman_visit_appointments_one_live_per_request_kind
        ON handyman_visit_appointments(handyman_request_id, kind)
        WHERE state IN ('PROPOSED', 'TENANT_SELECTED', 'CONFIRMED', 'IN_PROGRESS');
    `);
    // Even direct SQL must not associate the visit with another tenant,
    // building or quotation scope. These IDs are not caller-owned.
    await client.query(`
      CREATE FUNCTION handyman_visit_appointment_scope_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE expected RECORD;
      BEGIN
        SELECT r.client_id, r.tenant_company_id, r.building_id
          INTO expected FROM handyman_service_requests r
          WHERE r.id = NEW.handyman_request_id;
        IF NOT FOUND OR expected.client_id IS DISTINCT FROM NEW.client_id OR
          expected.tenant_company_id IS DISTINCT FROM NEW.tenant_company_id OR
          expected.building_id IS DISTINCT FROM NEW.building_id THEN
          RAISE EXCEPTION 'Handyman appointment request scope mismatch'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND
          (NEW.id, NEW.client_id, NEW.handyman_request_id, NEW.tenant_company_id,
           NEW.building_id, NEW.kind, NEW.execution_scope_id,
           NEW.resource_type, NEW.resource_id, NEW.start_at, NEW.end_at,
           NEW.timezone, NEW.created_by_user_id, NEW.created_at,
           NEW.supersedes_appointment_id) IS DISTINCT FROM
          (OLD.id, OLD.client_id, OLD.handyman_request_id, OLD.tenant_company_id,
           OLD.building_id, OLD.kind, OLD.execution_scope_id,
           OLD.resource_type, OLD.resource_id, OLD.start_at, OLD.end_at,
           OLD.timezone, OLD.created_by_user_id, OLD.created_at,
           OLD.supersedes_appointment_id) THEN
          RAISE EXCEPTION 'Appointment identity and slot are immutable; create a new visit to reschedule'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND (
          NEW.version <> OLD.version + 1 OR
          NOT (
            (OLD.state = 'PROPOSED' AND NEW.state IN ('TENANT_SELECTED','CANCELLED')) OR
            (OLD.state = 'TENANT_SELECTED' AND NEW.state IN ('CONFIRMED','CANCELLED')) OR
            (OLD.state = 'CONFIRMED' AND NEW.state IN ('IN_PROGRESS','CANCELLED')) OR
            (OLD.state = 'IN_PROGRESS' AND NEW.state IN ('COMPLETED','CANCELLED'))
          )
        ) THEN
          RAISE EXCEPTION 'Appointment status/version transition invalid'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.tenant_choice_evidence_ref IS NOT NULL
          AND NEW.tenant_choice_evidence_ref IS DISTINCT FROM OLD.tenant_choice_evidence_ref THEN
          RAISE EXCEPTION 'Tenant choice evidence reference is immutable'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.state IN ('TENANT_SELECTED','CONFIRMED','IN_PROGRESS','COMPLETED') AND
          (NEW.tenant_choice_evidence_ref IS NULL OR
           char_length(btrim(NEW.tenant_choice_evidence_ref)) < 1) THEN
          RAISE EXCEPTION 'Appointment tenant choice evidence required'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.state = 'CANCELLED' AND TG_OP = 'UPDATE' AND
          (NEW.cancelled_by_user_id IS NULL OR NEW.cancelled_at IS NULL) THEN
          RAISE EXCEPTION 'Appointment cancellation provenance required'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.kind = 'EXECUTION' AND NOT EXISTS (
          SELECT 1 FROM handyman_execution_scopes es
          WHERE es.id = NEW.execution_scope_id
            AND es.handyman_request_id = NEW.handyman_request_id
            AND es.client_id = NEW.client_id
        ) THEN
          RAISE EXCEPTION 'Handyman execution appointment scope mismatch'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $guard$;
      CREATE TRIGGER handyman_visit_appointment_scope_guard
        BEFORE INSERT OR UPDATE ON handyman_visit_appointments
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_appointment_scope_guard();
    `);
    await client.query(`
      CREATE TABLE handyman_visit_capacity_reservations (
        id UUID PRIMARY KEY,
        appointment_id UUID NOT NULL UNIQUE,
        client_id UUID NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('INSPECTOR_USER', 'CREW')),
        resource_id UUID NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        released_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_visit_capacity_appointment_scope_fk
          FOREIGN KEY (appointment_id, client_id)
          REFERENCES handyman_visit_appointments(id, client_id),
        CONSTRAINT handyman_visit_capacity_window_check CHECK (end_at > start_at),
        CONSTRAINT handyman_visit_capacity_release_check CHECK
          ((active AND released_at IS NULL) OR (NOT active AND released_at IS NOT NULL)),
        CONSTRAINT handyman_visit_capacity_no_double_book
          EXCLUDE USING gist (
            client_id WITH =, resource_type WITH =, resource_id WITH =,
            tstzrange(start_at, end_at, '[)') WITH &&
          ) WHERE (active)
      );
    `);
    // A capacity reservation must exactly reflect its parent booking;
    // otherwise a caller could reserve a harmless fake window.
    await client.query(`
      CREATE FUNCTION handyman_visit_capacity_scope_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      DECLARE expected RECORD;
      BEGIN
        IF TG_OP = 'UPDATE' AND
          (NEW.appointment_id, NEW.client_id, NEW.resource_type,
           NEW.resource_id, NEW.start_at, NEW.end_at) IS DISTINCT FROM
          (OLD.appointment_id, OLD.client_id, OLD.resource_type,
           OLD.resource_id, OLD.start_at, OLD.end_at) THEN
          RAISE EXCEPTION 'Handyman capacity reservation identity/window immutable'
            USING ERRCODE = '23514';
        END IF;
        SELECT a.client_id, a.resource_type, a.resource_id, a.start_at, a.end_at,
               a.state INTO expected
        FROM handyman_visit_appointments a WHERE a.id = NEW.appointment_id;
        IF NOT FOUND OR expected.client_id IS DISTINCT FROM NEW.client_id OR
          expected.resource_type IS DISTINCT FROM NEW.resource_type OR
          expected.resource_id IS DISTINCT FROM NEW.resource_id OR
          expected.start_at IS DISTINCT FROM NEW.start_at OR
          expected.end_at IS DISTINCT FROM NEW.end_at THEN
          RAISE EXCEPTION 'Handyman capacity reservation appointment mismatch'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.active AND expected.state NOT IN ('CONFIRMED', 'IN_PROGRESS') THEN
          RAISE EXCEPTION 'Capacity can be active only for a confirmed or active visit'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.active = FALSE AND NEW.active = TRUE THEN
          RAISE EXCEPTION 'Released reservations cannot be reactivated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $guard$;
      CREATE TRIGGER handyman_visit_capacity_scope_guard
        BEFORE INSERT OR UPDATE ON handyman_visit_capacity_reservations
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_capacity_scope_guard();
    `);
    // Deferred two-way invariant: a confirmed/in-progress appointment MUST
    // reserve its capacity in the same transaction, and cancellation/
    // completion MUST release that capacity in that transaction. A partial
    // command can never commit a confirmed-but-unreserved slot.
    await client.query(`
      CREATE FUNCTION handyman_visit_capacity_commit_guard() RETURNS trigger
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
      CREATE CONSTRAINT TRIGGER handyman_visit_appointment_capacity_commit_guard
        AFTER INSERT OR UPDATE ON handyman_visit_appointments
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION handyman_visit_capacity_commit_guard();
      CREATE CONSTRAINT TRIGGER handyman_visit_reservation_capacity_commit_guard
        AFTER INSERT OR UPDATE OR DELETE ON handyman_visit_capacity_reservations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION handyman_visit_capacity_commit_guard();
    `);
    await client.query(`
      CREATE TABLE handyman_visit_attempts (
        id UUID PRIMARY KEY,
        appointment_id UUID NOT NULL REFERENCES handyman_visit_appointments(id),
        actor_user_id UUID NOT NULL REFERENCES users(id),
        outcome TEXT NOT NULL CHECK
          (outcome IN ('COMPLETED', 'NO_SHOW', 'ACCESS_BLOCKED', 'ABORTED', 'REBOOK_REQUIRED')),
        evidence_reference TEXT,
        reason TEXT,
        idempotency_key TEXT NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 128),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(appointment_id, idempotency_key),
        CONSTRAINT handyman_visit_attempts_reason_check CHECK
          (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 1000)
      );
      CREATE INDEX handyman_visit_attempts_by_appointment_idx
        ON handyman_visit_attempts(appointment_id, recorded_at DESC);
      CREATE FUNCTION handyman_visit_attempts_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        RAISE EXCEPTION 'Visit attempts are append-only' USING ERRCODE = '23514';
      END $guard$;
      CREATE TRIGGER handyman_visit_attempts_immutable
        BEFORE UPDATE OR DELETE ON handyman_visit_attempts
        FOR EACH ROW EXECUTE FUNCTION handyman_visit_attempts_immutable();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS handyman_visit_attempts;
      DROP FUNCTION IF EXISTS handyman_visit_attempts_immutable();
      DROP TABLE IF EXISTS handyman_visit_capacity_reservations;
      DROP FUNCTION IF EXISTS handyman_visit_capacity_scope_guard();
      DROP TABLE IF EXISTS handyman_visit_appointments;
      DROP FUNCTION IF EXISTS handyman_visit_capacity_commit_guard();
      DROP FUNCTION IF EXISTS handyman_visit_appointment_scope_guard();
    `);
    // Intentionally retain shared btree_gist extension: it may be used by other modules.
  },
};
