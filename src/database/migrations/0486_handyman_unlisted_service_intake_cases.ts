import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CARE-UNLISTED-INTAKE — PART 01: Unlisted Service Intake + Internal Notes.
 *
 * Implements dedicated persistent storage (`handyman_unlisted_service_intake_cases`)
 * for Customer Care requests where the requested service is not present in the
 * global or Client-specific Service Catalog, without requiring a fake
 * `serviceCatalogId` or modifying the 24 global starter services.
 *
 * Also binds `handyman_internal_notes.unlisted_intake_case_id` (from 0485) to
 * `handyman_unlisted_service_intake_cases` via foreign keys and extends
 * `handyman_internal_notes_guard_insert()` to enforce server-side
 * Client/Tenant/Building/Space scope parity on `UNLISTED_SERVICE_INTAKE_CASE` notes.
 */
export const migration0486HandymanUnlistedServiceIntakeCases: Migration = {
  id: '0486_handyman_unlisted_service_intake_cases',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_unlisted_service_intake_cases (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        building_id UUID NOT NULL REFERENCES buildings (id) ON DELETE RESTRICT,
        space_id UUID NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id) ON DELETE RESTRICT,
        tenant_pic_id UUID NULL REFERENCES tenant_pics (id) ON DELETE RESTRICT,
        approval_tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id) ON DELETE RESTRICT,
        cost_responsible_tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id) ON DELETE RESTRICT,
        channel_attribution_id UUID NULL UNIQUE REFERENCES handyman_channel_attributions (id) ON DELETE RESTRICT,
        origin_channel TEXT NOT NULL
          CHECK (origin_channel IN ('CUSTOMER_CARE_BACKEND', 'BM_SUPER_APP')),
        origin_reference TEXT NULL,
        requested_service_name TEXT NOT NULL
          CHECK (
            char_length(btrim(requested_service_name)) BETWEEN 1 AND 250
          ),
        description TEXT NOT NULL
          CHECK (
            char_length(btrim(description)) BETWEEN 1 AND 2000
          ),
        preferred_window_start TIMESTAMPTZ NULL,
        preferred_window_end TIMESTAMPTZ NULL,
        preferred_window_timezone TEXT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING_TRIAGE'
          CHECK (status IN ('PENDING_TRIAGE')),
        created_by_user_id UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
        created_by_care_actor_id UUID NULL REFERENCES handyman_handoff_care_actors (id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL
          CHECK (
            char_length(btrim(idempotency_key)) BETWEEN 1 AND 200
            AND idempotency_key = btrim(idempotency_key)
          ),
        payload_hash TEXT NOT NULL
          CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_unlisted_intake_actor_provenance_check CHECK (
          num_nonnulls(created_by_user_id, created_by_care_actor_id) = 1
        ),
        CONSTRAINT handyman_unlisted_intake_care_actor_channel_check CHECK (
          created_by_care_actor_id IS NULL OR origin_channel = 'BM_SUPER_APP'
        ),
        CONSTRAINT handyman_unlisted_intake_preferred_window_check CHECK (
          (
            preferred_window_start IS NULL
            AND preferred_window_end IS NULL
            AND preferred_window_timezone IS NULL
          )
          OR (
            preferred_window_start IS NOT NULL
            AND preferred_window_end IS NOT NULL
            AND preferred_window_timezone IS NOT NULL
            AND preferred_window_end > preferred_window_start
            AND char_length(btrim(preferred_window_timezone)) BETWEEN 1 AND 120
          )
        ),
        CONSTRAINT handyman_unlisted_intake_scope_unique UNIQUE (id, client_id, building_id)
      );

      CREATE UNIQUE INDEX handyman_unlisted_intake_user_idempotency_idx
        ON handyman_unlisted_service_intake_cases (created_by_user_id, idempotency_key)
        WHERE created_by_user_id IS NOT NULL;

      CREATE UNIQUE INDEX handyman_unlisted_intake_care_actor_idempotency_idx
        ON handyman_unlisted_service_intake_cases (created_by_care_actor_id, idempotency_key)
        WHERE created_by_care_actor_id IS NOT NULL;

      CREATE INDEX handyman_unlisted_intake_ops_triage_idx
        ON handyman_unlisted_service_intake_cases (client_id, building_id, status, created_at DESC, id DESC);

      CREATE INDEX handyman_unlisted_intake_tenant_idx
        ON handyman_unlisted_service_intake_cases (tenant_company_id, building_id, created_at DESC);

      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_insert()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_building_client_id UUID;
        v_space_building_id UUID;
        v_tenant_client_id UUID;
        v_approval_client_id UUID;
        v_cost_client_id UUID;
        v_pic_tenant_id UUID;
        v_attr_client_id UUID;
        v_attr_tenant_id UUID;
        v_attr_building_id UUID;
        v_attr_space_id UUID;
      BEGIN
        SELECT p.client_id
          INTO v_building_client_id
          FROM buildings b
          JOIN properties p ON p.id = b.property_id
         WHERE b.id = NEW.building_id;

        IF v_building_client_id IS NULL OR v_building_client_id <> NEW.client_id THEN
          RAISE EXCEPTION 'handyman_unlisted_service_intake_cases.building_id must belong to client_id'
            USING ERRCODE = '23514';
        END IF;

        SELECT tc.client_id INTO v_tenant_client_id
          FROM tenant_companies tc
         WHERE tc.id = NEW.tenant_company_id;

        SELECT tc.client_id INTO v_approval_client_id
          FROM tenant_companies tc
         WHERE tc.id = NEW.approval_tenant_company_id;

        SELECT tc.client_id INTO v_cost_client_id
          FROM tenant_companies tc
         WHERE tc.id = NEW.cost_responsible_tenant_company_id;

        IF v_tenant_client_id IS DISTINCT FROM NEW.client_id
           OR v_approval_client_id IS DISTINCT FROM NEW.client_id
           OR v_cost_client_id IS DISTINCT FROM NEW.client_id THEN
          RAISE EXCEPTION 'handyman_unlisted_service_intake_cases tenant companies must belong to client_id'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.space_id IS NOT NULL THEN
          SELECT f.building_id
            INTO v_space_building_id
            FROM spaces s
            JOIN rooms r ON r.id = s.room_id
            JOIN areas a ON a.id = r.area_id
            JOIN floors f ON f.id = a.floor_id
           WHERE s.id = NEW.space_id;

          IF v_space_building_id IS DISTINCT FROM NEW.building_id THEN
            RAISE EXCEPTION 'handyman_unlisted_service_intake_cases.space_id must belong to building_id'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.tenant_pic_id IS NOT NULL THEN
          SELECT tp.tenant_company_id
            INTO v_pic_tenant_id
            FROM tenant_pics tp
           WHERE tp.id = NEW.tenant_pic_id;

          IF v_pic_tenant_id IS DISTINCT FROM NEW.tenant_company_id THEN
            RAISE EXCEPTION 'handyman_unlisted_service_intake_cases.tenant_pic_id must belong to tenant_company_id'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.channel_attribution_id IS NOT NULL THEN
          SELECT ca.client_id, ca.tenant_company_id, ca.building_id, ca.space_id
            INTO v_attr_client_id, v_attr_tenant_id, v_attr_building_id, v_attr_space_id
            FROM handyman_channel_attributions ca
           WHERE ca.id = NEW.channel_attribution_id;

          IF v_attr_client_id IS DISTINCT FROM NEW.client_id
             OR v_attr_tenant_id IS DISTINCT FROM NEW.tenant_company_id
             OR v_attr_building_id IS DISTINCT FROM NEW.building_id
             OR v_attr_space_id IS DISTINCT FROM NEW.space_id THEN
            RAISE EXCEPTION 'handyman_unlisted_service_intake_cases scope must match channel_attribution_id'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.created_by_user_id IS NOT NULL THEN
          IF EXISTS (
            SELECT 1
              FROM tenant_pics tp
             WHERE tp.user_id = NEW.created_by_user_id
          ) THEN
            RAISE EXCEPTION 'Customer-facing Tenant PIC accounts cannot create Care unlisted service intake cases'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_insert
      BEFORE INSERT ON handyman_unlisted_service_intake_cases
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_insert();

      CREATE OR REPLACE FUNCTION handyman_unlisted_intake_guard_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'handyman_unlisted_service_intake_cases is an audit record; DELETE is forbidden'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.id <> OLD.id
           OR NEW.client_id <> OLD.client_id
           OR NEW.building_id <> OLD.building_id
           OR NEW.space_id IS DISTINCT FROM OLD.space_id
           OR NEW.tenant_company_id <> OLD.tenant_company_id
           OR NEW.tenant_pic_id IS DISTINCT FROM OLD.tenant_pic_id
           OR NEW.approval_tenant_company_id <> OLD.approval_tenant_company_id
           OR NEW.cost_responsible_tenant_company_id <> OLD.cost_responsible_tenant_company_id
           OR NEW.channel_attribution_id IS DISTINCT FROM OLD.channel_attribution_id
           OR NEW.origin_channel <> OLD.origin_channel
           OR NEW.origin_reference IS DISTINCT FROM OLD.origin_reference
           OR NEW.requested_service_name <> OLD.requested_service_name
           OR NEW.description <> OLD.description
           OR NEW.preferred_window_start IS DISTINCT FROM OLD.preferred_window_start
           OR NEW.preferred_window_end IS DISTINCT FROM OLD.preferred_window_end
           OR NEW.preferred_window_timezone IS DISTINCT FROM OLD.preferred_window_timezone
           OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
           OR NEW.created_by_care_actor_id IS DISTINCT FROM OLD.created_by_care_actor_id
           OR NEW.idempotency_key <> OLD.idempotency_key
           OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'handyman_unlisted_service_intake_cases intake fields and provenance are immutable'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_handyman_unlisted_intake_guard_mutation
      BEFORE UPDATE OR DELETE ON handyman_unlisted_service_intake_cases
      FOR EACH ROW
      EXECUTE FUNCTION handyman_unlisted_intake_guard_mutation();

      ALTER TABLE handyman_internal_notes
        ADD CONSTRAINT handyman_internal_notes_unlisted_intake_case_id_fkey
          FOREIGN KEY (unlisted_intake_case_id)
          REFERENCES handyman_unlisted_service_intake_cases (id)
          ON DELETE RESTRICT,
        ADD CONSTRAINT handyman_internal_notes_unlisted_intake_scope_fkey
          FOREIGN KEY (unlisted_intake_case_id, client_id, building_id)
          REFERENCES handyman_unlisted_service_intake_cases (id, client_id, building_id)
          ON DELETE RESTRICT;

      CREATE OR REPLACE FUNCTION handyman_internal_notes_guard_insert()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_client_id UUID;
        v_tenant_company_id UUID;
        v_building_id UUID;
        v_space_id UUID;
      BEGIN
        IF NEW.visibility_classification <> 'INTERNAL_ONLY' THEN
          RAISE EXCEPTION 'Internal notes must retain INTERNAL_ONLY visibility classification'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.subject_type = 'SERVICE_REQUEST' THEN
          SELECT r.client_id, r.tenant_company_id, r.building_id, r.space_id
            INTO v_client_id, v_tenant_company_id, v_building_id, v_space_id
            FROM handyman_service_requests r
           WHERE r.id = NEW.handyman_request_id;

          IF v_client_id IS NULL THEN
            RAISE EXCEPTION 'handyman_internal_notes.handyman_request_id must reference an existing service request'
              USING ERRCODE = '23503';
          END IF;

          IF NEW.client_id <> v_client_id
             OR NEW.tenant_company_id <> v_tenant_company_id
             OR NEW.building_id <> v_building_id
             OR NEW.space_id IS DISTINCT FROM v_space_id THEN
            RAISE EXCEPTION 'handyman_internal_notes scope must match the authoritative service request'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.subject_type = 'UNLISTED_SERVICE_INTAKE_CASE' THEN
          SELECT c.client_id, c.tenant_company_id, c.building_id, c.space_id
            INTO v_client_id, v_tenant_company_id, v_building_id, v_space_id
            FROM handyman_unlisted_service_intake_cases c
           WHERE c.id = NEW.unlisted_intake_case_id;

          IF v_client_id IS NULL THEN
            RAISE EXCEPTION 'handyman_internal_notes.unlisted_intake_case_id must reference an existing unlisted service intake case'
              USING ERRCODE = '23503';
          END IF;

          IF NEW.client_id <> v_client_id
             OR NEW.tenant_company_id <> v_tenant_company_id
             OR NEW.building_id <> v_building_id
             OR NEW.space_id IS DISTINCT FROM v_space_id THEN
            RAISE EXCEPTION 'handyman_internal_notes scope must match the authoritative unlisted service intake case'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.created_by_user_id IS NOT NULL THEN
          IF EXISTS (
            SELECT 1
              FROM tenant_pics tp
             WHERE tp.user_id = NEW.created_by_user_id
          ) THEN
            RAISE EXCEPTION 'Customer-facing Tenant PIC accounts cannot author internal notes'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_unlisted_service_intake_cases)
           OR EXISTS (
             SELECT 1
               FROM handyman_internal_notes
              WHERE subject_type = 'UNLISTED_SERVICE_INTAKE_CASE'
           ) THEN
          RAISE EXCEPTION 'Cannot roll back handyman_unlisted_service_intake_cases while audit records exist'
            USING ERRCODE = '23514';
        END IF;
      END $$;

      ALTER TABLE handyman_internal_notes
        DROP CONSTRAINT IF EXISTS handyman_internal_notes_unlisted_intake_scope_fkey,
        DROP CONSTRAINT IF EXISTS handyman_internal_notes_unlisted_intake_case_id_fkey;

      CREATE OR REPLACE FUNCTION handyman_internal_notes_guard_insert()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_client_id UUID;
        v_tenant_company_id UUID;
        v_building_id UUID;
        v_space_id UUID;
      BEGIN
        IF NEW.visibility_classification <> 'INTERNAL_ONLY' THEN
          RAISE EXCEPTION 'Internal notes must retain INTERNAL_ONLY visibility classification'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.subject_type = 'SERVICE_REQUEST' THEN
          SELECT r.client_id, r.tenant_company_id, r.building_id, r.space_id
            INTO v_client_id, v_tenant_company_id, v_building_id, v_space_id
            FROM handyman_service_requests r
           WHERE r.id = NEW.handyman_request_id;

          IF v_client_id IS NULL THEN
            RAISE EXCEPTION 'handyman_internal_notes.handyman_request_id must reference an existing service request'
              USING ERRCODE = '23503';
          END IF;

          IF NEW.client_id <> v_client_id
             OR NEW.tenant_company_id <> v_tenant_company_id
             OR NEW.building_id <> v_building_id
             OR NEW.space_id IS DISTINCT FROM v_space_id THEN
            RAISE EXCEPTION 'handyman_internal_notes scope must match the authoritative service request'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        IF NEW.created_by_user_id IS NOT NULL THEN
          IF EXISTS (
            SELECT 1
              FROM tenant_pics tp
             WHERE tp.user_id = NEW.created_by_user_id
          ) THEN
            RAISE EXCEPTION 'Customer-facing Tenant PIC accounts cannot author internal notes'
              USING ERRCODE = '23514';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_handyman_unlisted_intake_guard_mutation ON handyman_unlisted_service_intake_cases;
      DROP FUNCTION IF EXISTS handyman_unlisted_intake_guard_mutation();
      DROP TRIGGER IF EXISTS trg_handyman_unlisted_intake_guard_insert ON handyman_unlisted_service_intake_cases;
      DROP FUNCTION IF EXISTS handyman_unlisted_intake_guard_insert();
      DROP TABLE IF EXISTS handyman_unlisted_service_intake_cases;
    `);
  },
};
