import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CARE-INTERNAL-NOTES-01 — PART 01: Backend Internal Notes.
 *
 * Dedicated, append-only internal operational notes shared by Customer Care
 * and authorized Handyman Operations within their authoritative Client/Building
 * scope. Stored separately from customer complaints, structured request items,
 * technical attributes, access conditions, quotations, BAST, invoices/payments
 * and neutral customer communications.
 *
 * Schema compatibility for future UNLISTED_SERVICE intake cases:
 *   - `subject_type` supports `'SERVICE_REQUEST'` (current active workflow)
 *     and `'UNLISTED_SERVICE_INTAKE_CASE'` (future intake case extension path)
 *     without referencing nonexistent tables or mutating/copying historical
 *     notes when an intake case is later mapped to a catalog service request.
 */
export const migration0485HandymanInternalNotes: Migration = {
  id: '0485_handyman_internal_notes',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_internal_notes (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id) ON DELETE RESTRICT,
        building_id UUID NOT NULL REFERENCES buildings (id) ON DELETE RESTRICT,
        space_id UUID NULL REFERENCES spaces (id) ON DELETE RESTRICT,
        subject_type TEXT NOT NULL DEFAULT 'SERVICE_REQUEST'
          CHECK (subject_type IN ('SERVICE_REQUEST', 'UNLISTED_SERVICE_INTAKE_CASE')),
        handyman_request_id UUID NULL REFERENCES handyman_service_requests (id) ON DELETE RESTRICT,
        unlisted_intake_case_id UUID NULL,
        visibility_classification TEXT NOT NULL DEFAULT 'INTERNAL_ONLY'
          CHECK (visibility_classification = 'INTERNAL_ONLY'),
        author_role TEXT NOT NULL
          CHECK (author_role IN ('CUSTOMER_CARE', 'OPERATIONS')),
        created_by_user_id UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
        created_by_care_actor_id UUID NULL REFERENCES handyman_handoff_care_actors (id) ON DELETE RESTRICT,
      content TEXT NOT NULL
        CHECK (
          char_length(btrim(content)) >= 1
          AND char_length(content) <= 4000
        ),
        idempotency_key TEXT NOT NULL
          CHECK (
            char_length(btrim(idempotency_key)) BETWEEN 1 AND 200
            AND idempotency_key = btrim(idempotency_key)
          ),
        payload_hash TEXT NOT NULL
          CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_internal_notes_subject_binding_check CHECK (
          (subject_type = 'SERVICE_REQUEST' AND handyman_request_id IS NOT NULL AND unlisted_intake_case_id IS NULL)
          OR (subject_type = 'UNLISTED_SERVICE_INTAKE_CASE' AND unlisted_intake_case_id IS NOT NULL AND handyman_request_id IS NULL)
        ),
        CONSTRAINT handyman_internal_notes_actor_provenance_check CHECK (
          num_nonnulls(created_by_user_id, created_by_care_actor_id) = 1
        ),
        CONSTRAINT handyman_internal_notes_care_actor_role_check CHECK (
          created_by_care_actor_id IS NULL OR author_role = 'CUSTOMER_CARE'
        ),
        FOREIGN KEY (handyman_request_id, client_id, building_id)
          REFERENCES handyman_service_requests (id, client_id, building_id)
      );

      CREATE UNIQUE INDEX handyman_internal_notes_user_idempotency_idx
        ON handyman_internal_notes (created_by_user_id, idempotency_key)
        WHERE created_by_user_id IS NOT NULL;

      CREATE UNIQUE INDEX handyman_internal_notes_care_actor_idempotency_idx
        ON handyman_internal_notes (created_by_care_actor_id, idempotency_key)
        WHERE created_by_care_actor_id IS NOT NULL;

      CREATE INDEX handyman_internal_notes_request_chronological_idx
        ON handyman_internal_notes (handyman_request_id, created_at ASC, id ASC)
        WHERE handyman_request_id IS NOT NULL;

      CREATE INDEX handyman_internal_notes_unlisted_case_chronological_idx
        ON handyman_internal_notes (unlisted_intake_case_id, created_at ASC, id ASC)
        WHERE unlisted_intake_case_id IS NOT NULL;

      CREATE INDEX handyman_internal_notes_scope_idx
        ON handyman_internal_notes (client_id, building_id, created_at DESC);

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

      CREATE TRIGGER trg_handyman_internal_notes_guard_insert
      BEFORE INSERT ON handyman_internal_notes
      FOR EACH ROW
      EXECUTE FUNCTION handyman_internal_notes_guard_insert();

      CREATE OR REPLACE FUNCTION handyman_internal_notes_immutable_guard()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'handyman_internal_notes is append-only; UPDATE and DELETE are forbidden'
          USING ERRCODE = '23514';
      END;
      $$;

      CREATE TRIGGER trg_handyman_internal_notes_immutable
      BEFORE UPDATE OR DELETE ON handyman_internal_notes
      FOR EACH ROW
      EXECUTE FUNCTION handyman_internal_notes_immutable_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_internal_notes) THEN
          RAISE EXCEPTION 'Cannot roll back handyman_internal_notes while audit records exist'
            USING ERRCODE = '23514';
        END IF;
      END $$;
      DROP TRIGGER IF EXISTS trg_handyman_internal_notes_immutable ON handyman_internal_notes;
      DROP FUNCTION IF EXISTS handyman_internal_notes_immutable_guard();
      DROP TRIGGER IF EXISTS trg_handyman_internal_notes_guard_insert ON handyman_internal_notes;
      DROP FUNCTION IF EXISTS handyman_internal_notes_guard_insert();
      DROP TABLE IF EXISTS handyman_internal_notes;
    `);
  },
};
