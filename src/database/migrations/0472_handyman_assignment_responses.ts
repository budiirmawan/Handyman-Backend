import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A — Assignment Response Core & Standard Work Order.
 *
 * Establishes a single, assignment-ID-keyed response and decision history model
 * across Work Order Assignments (`WORK_ORDER_ASSIGNMENT`), Handyman Execution
 * Scope Crew Assignments (`EXECUTION_SCOPE_ASSIGNMENT`), and Handyman Inspector
 * Visit Assignments (`INSPECTOR_VISIT_ASSIGNMENT`):
 *   1. `handyman_assignment_responses`: Canonical per-assignment response state
 *      (`PENDING` | `TERIMA` | `TIDAK_BISA`) storing actor, server timestamps,
 *      mandatory decline reason when `TIDAK_BISA`, optional linked Work Order
 *      action id (`ACKNOWLEDGED`), and version. Terminal decisions (`TERIMA`,
 *      `TIDAK_BISA`) on a given `assignment_id` are immutable, and records
 *      cannot be deleted so superseded assignments retain historical response
 *      facts without granting execution authority.
 *   2. `handyman_assignment_response_events`: Append-only decision history
 *      capturing initial `PENDING` creation, `TERIMA` acceptance,
 *      `TIDAK_BISA` decline with reason, and `ASSIGNMENT_SUPERSEDED` events.
 *   3. `notifications_assignment_response_dedup_idx`: Partial unique index on
 *      `notifications` preventing duplicate `IN_APP` assignment-response
 *      notifications across retries and reassignments.
 */
export const migration0472HandymanAssignmentResponses: Migration = {
  id: '0472_handyman_assignment_responses',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS handyman_assignment_responses (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        assignment_target_type      TEXT NOT NULL,
        assignment_id               UUID NOT NULL,
        work_order_id               UUID REFERENCES work_orders (id),
        handyman_request_id         UUID REFERENCES handyman_service_requests (id),
        execution_scope_id          UUID REFERENCES handyman_execution_scopes (id),
        visit_appointment_id        UUID REFERENCES handyman_visit_appointments (id),
        assigned_by_user_id         UUID NOT NULL REFERENCES users (id),
        assigned_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        response_status             TEXT NOT NULL DEFAULT 'PENDING',
        responded_by_user_id        UUID REFERENCES users (id),
        responded_by_worker_id      UUID REFERENCES handyman_worker_contexts (id),
        responded_at                TIMESTAMPTZ,
        decline_reason              TEXT,
        response_notes              TEXT,
        linked_work_order_action_id UUID REFERENCES work_order_actions (id),
        idempotency_key             TEXT,
        version                     INTEGER NOT NULL DEFAULT 1,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hm_assign_resp_target_type_check
          CHECK (assignment_target_type IN (
            'WORK_ORDER_ASSIGNMENT',
            'EXECUTION_SCOPE_ASSIGNMENT',
            'INSPECTOR_VISIT_ASSIGNMENT'
          )),
        CONSTRAINT hm_assign_resp_status_check
          CHECK (response_status IN ('PENDING', 'TERIMA', 'TIDAK_BISA')),
        CONSTRAINT hm_assign_resp_version_check
          CHECK (version >= 1),
        CONSTRAINT hm_assign_resp_target_shape_check
          CHECK (
            (assignment_target_type = 'WORK_ORDER_ASSIGNMENT'
              AND work_order_id IS NOT NULL)
            OR (assignment_target_type = 'EXECUTION_SCOPE_ASSIGNMENT'
              AND execution_scope_id IS NOT NULL
              AND handyman_request_id IS NOT NULL)
            OR (assignment_target_type = 'INSPECTOR_VISIT_ASSIGNMENT'
              AND visit_appointment_id IS NOT NULL
              AND handyman_request_id IS NOT NULL)
          ),
        CONSTRAINT hm_assign_resp_decision_shape_check
          CHECK (
            (response_status = 'PENDING'
              AND responded_by_user_id IS NULL
              AND responded_at IS NULL
              AND decline_reason IS NULL)
            OR (response_status = 'TERIMA'
              AND responded_by_user_id IS NOT NULL
              AND responded_at IS NOT NULL
              AND decline_reason IS NULL)
            OR (response_status = 'TIDAK_BISA'
              AND responded_by_user_id IS NOT NULL
              AND responded_at IS NOT NULL
              AND decline_reason IS NOT NULL
              AND length(btrim(decline_reason)) > 0)
          ),
        CONSTRAINT hm_assign_resp_assignment_uniq
          UNIQUE (assignment_id),
        CONSTRAINT hm_assign_resp_target_assignment_uniq
          UNIQUE (assignment_target_type, assignment_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS hm_assign_resp_wo_idx
        ON handyman_assignment_responses (work_order_id, response_status, updated_at)
        WHERE work_order_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS hm_assign_resp_scope_idx
        ON handyman_assignment_responses (execution_scope_id, response_status, updated_at)
        WHERE execution_scope_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS hm_assign_resp_visit_idx
        ON handyman_assignment_responses (visit_appointment_id, response_status, updated_at)
        WHERE visit_appointment_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS handyman_assignment_response_events (
        id                     UUID PRIMARY KEY,
        response_id            UUID NOT NULL REFERENCES handyman_assignment_responses (id),
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        assignment_target_type TEXT NOT NULL,
        assignment_id          UUID NOT NULL,
        work_order_id          UUID REFERENCES work_orders (id),
        handyman_request_id    UUID REFERENCES handyman_service_requests (id),
        execution_scope_id     UUID REFERENCES handyman_execution_scopes (id),
        visit_appointment_id   UUID REFERENCES handyman_visit_appointments (id),
        event_type             TEXT NOT NULL,
        previous_status        TEXT,
        new_status             TEXT NOT NULL,
        decline_reason         TEXT,
        notes                  TEXT,
        actor_user_id          UUID NOT NULL REFERENCES users (id),
        actor_worker_id        UUID REFERENCES handyman_worker_contexts (id),
        idempotency_key        TEXT NOT NULL,
        occurred_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hm_assign_resp_evt_target_type_check
          CHECK (assignment_target_type IN (
            'WORK_ORDER_ASSIGNMENT',
            'EXECUTION_SCOPE_ASSIGNMENT',
            'INSPECTOR_VISIT_ASSIGNMENT'
          )),
        CONSTRAINT hm_assign_resp_evt_type_check
          CHECK (event_type IN (
            'ASSIGNMENT_PENDING_CREATED',
            'ASSIGNMENT_ACCEPTED',
            'ASSIGNMENT_DECLINED',
            'ASSIGNMENT_SUPERSEDED'
          )),
        CONSTRAINT hm_assign_resp_evt_prev_status_check
          CHECK (previous_status IS NULL OR previous_status IN ('PENDING', 'TERIMA', 'TIDAK_BISA')),
        CONSTRAINT hm_assign_resp_evt_new_status_check
          CHECK (new_status IN ('PENDING', 'TERIMA', 'TIDAK_BISA')),
        CONSTRAINT hm_assign_resp_evt_decline_reason_check
          CHECK (
            (event_type = 'ASSIGNMENT_DECLINED'
              AND new_status = 'TIDAK_BISA'
              AND decline_reason IS NOT NULL
              AND length(btrim(decline_reason)) > 0)
            OR (event_type <> 'ASSIGNMENT_DECLINED')
          ),
        CONSTRAINT hm_assign_resp_evt_idem_uniq
          UNIQUE (assignment_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS hm_assign_resp_events_assignment_idx
        ON handyman_assignment_response_events (assignment_id, occurred_at, id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS hm_assign_resp_events_wo_idx
        ON handyman_assignment_response_events (work_order_id, occurred_at, id)
        WHERE work_order_id IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS notifications_assignment_response_dedup_idx
        ON notifications (recipient_user_id, source_entity_type, source_entity_id, source_event_type)
        WHERE source_entity_type IN (
          'WORK_ORDER_ASSIGNMENT',
          'EXECUTION_SCOPE_ASSIGNMENT',
          'INSPECTOR_VISIT_ASSIGNMENT'
        )
        AND source_event_type IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE notifications
        DROP CONSTRAINT IF EXISTS notifications_navigation_target_check;
      ALTER TABLE notifications
        ADD CONSTRAINT notifications_navigation_target_check CHECK (
          (
            navigation_target_type IS NULL
            AND navigation_target_id IS NULL
          )
          OR (
            navigation_target_type IN (
              'WORK_ORDER_FIELD_WORK',
              'EXECUTION_SCOPE_FIELD_WORK',
              'INSPECTOR_VISIT_FIELD_WORK'
            )
            AND navigation_target_id IS NOT NULL
          )
        );
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_assignment_response_events_append_only()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman assignment response decision history events are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS hm_assign_resp_events_immutable
        ON handyman_assignment_response_events;
      CREATE TRIGGER hm_assign_resp_events_immutable
        BEFORE UPDATE OR DELETE ON handyman_assignment_response_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_assignment_response_events_append_only();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_assignment_responses_no_delete()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman assignment response records cannot be deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS hm_assign_resp_no_delete
        ON handyman_assignment_responses;
      CREATE TRIGGER hm_assign_resp_no_delete
        BEFORE DELETE ON handyman_assignment_responses
        FOR EACH ROW
        EXECUTE FUNCTION handyman_assignment_responses_no_delete();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_assignment_responses_terminal_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.response_status IN ('TERIMA', 'TIDAK_BISA')
           AND NEW.response_status <> OLD.response_status THEN
          RAISE EXCEPTION 'Finalized assignment response (%) on assignment % cannot transition to %.',
            OLD.response_status, OLD.assignment_id, NEW.response_status;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS hm_assign_resp_terminal_immutable
        ON handyman_assignment_responses;
      CREATE TRIGGER hm_assign_resp_terminal_immutable
        BEFORE UPDATE ON handyman_assignment_responses
        FOR EACH ROW
        EXECUTE FUNCTION handyman_assignment_responses_terminal_immutable();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS hm_assign_resp_terminal_immutable
        ON handyman_assignment_responses;
      DROP TRIGGER IF EXISTS hm_assign_resp_no_delete
        ON handyman_assignment_responses;
      DROP TRIGGER IF EXISTS hm_assign_resp_events_immutable
        ON handyman_assignment_response_events;
      DROP FUNCTION IF EXISTS handyman_assignment_responses_terminal_immutable;
      DROP FUNCTION IF EXISTS handyman_assignment_responses_no_delete;
      DROP FUNCTION IF EXISTS handyman_assignment_response_events_append_only;
      DROP INDEX IF EXISTS notifications_assignment_response_dedup_idx;
      UPDATE notifications
         SET navigation_target_type = NULL,
             navigation_target_id = NULL
       WHERE navigation_target_type IN (
         'EXECUTION_SCOPE_FIELD_WORK',
         'INSPECTOR_VISIT_FIELD_WORK'
       );
      ALTER TABLE notifications
        DROP CONSTRAINT IF EXISTS notifications_navigation_target_check;
      ALTER TABLE notifications
        ADD CONSTRAINT notifications_navigation_target_check CHECK (
          (
            navigation_target_type IS NULL
            AND navigation_target_id IS NULL
          )
          OR (
            navigation_target_type IN ('WORK_ORDER_FIELD_WORK')
            AND navigation_target_id IS NOT NULL
          )
        );
      DROP TABLE IF EXISTS handyman_assignment_response_events;
      DROP TABLE IF EXISTS handyman_assignment_responses;
    `);
  },
};
