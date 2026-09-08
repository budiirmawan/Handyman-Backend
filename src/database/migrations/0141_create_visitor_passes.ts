import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13I — Visitor Pass.
 *
 * A pass belongs to one concrete BE-13G/H visit lifecycle row. Client,
 * Building and visitor context therefore derive from `visit_check_ins`;
 * the pass does not duplicate visitor identity or model physical access
 * control hardware.
 *
 * Lifecycle:
 *   ACTIVE → RETURNED | CANCELLED
 *
 * Pass codes are globally unique and a partial unique index allows at
 * most one ACTIVE pass for a visit. Cross-table triggers serialize pass
 * issue with visit closure, ensuring an ACTIVE pass can only be issued
 * for a CHECKED_IN visit and Check-Out / cancellation cannot leave an
 * unresolved pass behind.
 */
export const migration0141CreateVisitorPasses: Migration = {
  id: '0141_create_visitor_passes',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE visitor_passes (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        visit_check_in_id     UUID NOT NULL REFERENCES visit_check_ins (id),
        pass_code             TEXT NOT NULL,
        issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        issued_by_user_id     UUID NOT NULL REFERENCES users (id),
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        returned_at           TIMESTAMPTZ,
        returned_by_user_id   UUID REFERENCES users (id),
        cancelled_at          TIMESTAMPTZ,
        cancelled_by_user_id  UUID REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT visitor_passes_status_check
          CHECK (status IN ('ACTIVE', 'RETURNED', 'CANCELLED')),
        CONSTRAINT visitor_passes_code_unique UNIQUE (pass_code),
        CONSTRAINT visitor_passes_resolution_consistency
          CHECK (
            (status = 'ACTIVE'
              AND returned_at IS NULL
              AND returned_by_user_id IS NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL)
            OR (status = 'RETURNED'
              AND returned_at IS NOT NULL
              AND returned_by_user_id IS NOT NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL)
            OR (status = 'CANCELLED'
              AND returned_at IS NULL
              AND returned_by_user_id IS NULL
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL)
          ),
        CONSTRAINT visitor_passes_return_time_check
          CHECK (returned_at IS NULL OR returned_at >= issued_at),
        CONSTRAINT visitor_passes_cancel_time_check
          CHECK (cancelled_at IS NULL OR cancelled_at >= issued_at)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX visitor_passes_active_visit_unique
        ON visitor_passes (visit_check_in_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX visitor_passes_building_idx
        ON visitor_passes (building_id, status, issued_at);
      CREATE INDEX visitor_passes_client_idx
        ON visitor_passes (client_id, status);
      CREATE INDEX visitor_passes_visit_idx
        ON visitor_passes (visit_check_in_id, issued_at);
    `);

    // Lock the visit lifecycle row while an ACTIVE pass is inserted.
    // This serializes issue against Check-Out / cancellation and also
    // enforces the denormalized Client / Building context.
    await client.query(`
      CREATE FUNCTION enforce_visitor_pass_active_visit()
      RETURNS TRIGGER AS $$
      DECLARE
        visit_client_id UUID;
        visit_building_id UUID;
        visit_status TEXT;
      BEGIN
        IF NEW.status <> 'ACTIVE' THEN
          RETURN NEW;
        END IF;

        SELECT client_id, building_id, status
          INTO visit_client_id, visit_building_id, visit_status
        FROM visit_check_ins
        WHERE id = NEW.visit_check_in_id
        FOR UPDATE;

        IF NOT FOUND OR visit_status <> 'CHECKED_IN' THEN
          RAISE EXCEPTION 'visitor pass requires an active checked-in visit'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'visitor_passes_active_visit_check';
        END IF;

        IF NEW.client_id <> visit_client_id
           OR NEW.building_id <> visit_building_id THEN
          RAISE EXCEPTION 'visitor pass context must match its visit'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'visitor_passes_visit_context_check';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER visitor_passes_active_visit_trigger
        BEFORE INSERT OR UPDATE OF status, visit_check_in_id,
          client_id, building_id
        ON visitor_passes
        FOR EACH ROW
        EXECUTE FUNCTION enforce_visitor_pass_active_visit();
    `);

    // An active pass must be resolved before the visit lifecycle can
    // leave CHECKED_IN. This protects both Check-Out and mistake
    // cancellation, including concurrent issue / closure attempts.
    await client.query(`
      CREATE FUNCTION prevent_visit_closure_with_active_pass()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status = 'CHECKED_IN'
           AND NEW.status <> 'CHECKED_IN'
           AND EXISTS (
             SELECT 1
             FROM visitor_passes
             WHERE visit_check_in_id = NEW.id
               AND status = 'ACTIVE'
           ) THEN
          RAISE EXCEPTION 'active visitor pass must be resolved before visit closure'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'visitor_passes_active_at_visit_closure';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER visit_check_ins_active_pass_trigger
        BEFORE UPDATE OF status
        ON visit_check_ins
        FOR EACH ROW
        EXECUTE FUNCTION prevent_visit_closure_with_active_pass();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS visit_check_ins_active_pass_trigger
        ON visit_check_ins;
      DROP FUNCTION IF EXISTS prevent_visit_closure_with_active_pass();
      DROP TABLE IF EXISTS visitor_passes;
      DROP FUNCTION IF EXISTS enforce_visitor_pass_active_visit();
    `);
  },
};
