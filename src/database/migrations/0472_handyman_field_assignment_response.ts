import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-ASSIGNMENT-RESPONSE-01 PART 01 — Assignment Response, Deadline
 * Policy & Immutable Response History.
 *
 * Numbered 0472 to avoid collisions with:
 *   - PR #55 (`arena/3df97f5e-handyman-backend`: 0461..0467),
 *   - IAM Revocation (`arena/37aa07d3-handyman-backend`: 0468),
 *   - CR-HM-FIELD-EXPENSE-HELPER-01 (`0470`..`0471`).
 *
 * PostgreSQL 18.4 compatible (zero min(uuid)/max(uuid) aggregates).
 * Preserves frozen `handyman_execution_scope_assignments` column surface
 * (0396/0439) by storing 1-to-1 response state and append-only audit events
 * in dedicated relational tables across:
 *   - `EXECUTION_SCOPE_CREW` (`handyman_execution_scope_assignments.id`),
 *   - `INSPECTION_VISIT` (`handyman_inspector_assignments.id`),
 *   - `WORK_ORDER` (`work_order_assignments.id`).
 *
 * Auto-reassignment is explicitly forbidden (`auto_reassign_enabled = FALSE`
 * CHECK constraint) until explicit business rules are authorized.
 */
export const migration0472HandymanFieldAssignmentResponse: Migration = {
  id: '0472_handyman_field_assignment_response',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_assignment_response_policies (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID REFERENCES buildings (id),
        deadline_minutes      INTEGER NOT NULL
          CHECK (deadline_minutes BETWEEN 1 AND 10080),
        auto_reassign_enabled BOOLEAN NOT NULL DEFAULT FALSE
          CHECK (auto_reassign_enabled = FALSE),
        updated_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX handyman_assignment_resp_policy_client_idx
        ON handyman_assignment_response_policies (client_id)
        WHERE building_id IS NULL;

      CREATE UNIQUE INDEX handyman_assignment_resp_policy_building_idx
        ON handyman_assignment_response_policies (client_id, building_id)
        WHERE building_id IS NOT NULL;
    `);

    await client.query(`
      CREATE TABLE handyman_assignment_responses (
        id                           UUID PRIMARY KEY,
        client_id                    UUID NOT NULL REFERENCES clients (id),
        building_id                  UUID NOT NULL REFERENCES buildings (id),
        assignment_kind              TEXT NOT NULL
          CHECK (assignment_kind IN (
            'EXECUTION_SCOPE_CREW',
            'INSPECTION_VISIT',
            'WORK_ORDER'
          )),
        assignment_id                UUID NOT NULL UNIQUE,
        execution_scope_id           UUID REFERENCES handyman_execution_scopes (id),
        handyman_request_id          UUID,
        visit_appointment_id         UUID REFERENCES handyman_visit_appointments (id),
        work_order_id                UUID REFERENCES work_orders (id),
        expected_responder_user_id   UUID REFERENCES users (id),
        assigned_by_user_id          UUID NOT NULL REFERENCES users (id),
        assigned_at                  TIMESTAMPTZ NOT NULL,
        deadline_minutes             INTEGER NOT NULL
          CHECK (deadline_minutes BETWEEN 1 AND 10080),
        response_deadline_at         TIMESTAMPTZ NOT NULL,
        response_status              TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (response_status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'SUPERSEDED')),
        response_code                TEXT
          CHECK (
            (response_status = 'ACCEPTED' AND response_code = 'TERIMA')
            OR (response_status = 'DECLINED' AND response_code = 'TIDAK_BISA')
            OR (response_status IN ('PENDING', 'SUPERSEDED') AND response_code IS NULL)
          ),
        decline_reason               TEXT
          CHECK (
            (response_status = 'DECLINED' AND char_length(btrim(decline_reason)) BETWEEN 1 AND 1000)
            OR (response_status <> 'DECLINED' AND decline_reason IS NULL)
          ),
        response_notes               TEXT
          CHECK (response_notes IS NULL OR char_length(response_notes) <= 1000),
        responded_by_user_id         UUID REFERENCES users (id),
        responded_at                 TIMESTAMPTZ,
        superseded_at                TIMESTAMPTZ,
        superseded_by_assignment_id  UUID,
        version                      INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_assignment_responses_target_check CHECK (
          (assignment_kind = 'EXECUTION_SCOPE_CREW'
             AND execution_scope_id IS NOT NULL
             AND visit_appointment_id IS NULL
             AND work_order_id IS NULL)
          OR (assignment_kind = 'INSPECTION_VISIT'
             AND visit_appointment_id IS NOT NULL
             AND handyman_request_id IS NOT NULL
             AND execution_scope_id IS NULL
             AND work_order_id IS NULL)
          OR (assignment_kind = 'WORK_ORDER'
             AND work_order_id IS NOT NULL
             AND execution_scope_id IS NULL
             AND visit_appointment_id IS NULL)
        ),
        CONSTRAINT handyman_assignment_responses_responder_check CHECK (
          (response_status IN ('ACCEPTED', 'DECLINED')
             AND responded_by_user_id IS NOT NULL
             AND responded_at IS NOT NULL)
          OR (response_status = 'PENDING'
             AND responded_by_user_id IS NULL
             AND responded_at IS NULL)
          OR (response_status = 'SUPERSEDED'
             AND superseded_at IS NOT NULL)
        )
      );

      CREATE INDEX handyman_assignment_responses_scope_idx
        ON handyman_assignment_responses (client_id, execution_scope_id, assigned_at DESC, id DESC)
        WHERE execution_scope_id IS NOT NULL;

      CREATE INDEX handyman_assignment_responses_visit_idx
        ON handyman_assignment_responses (client_id, visit_appointment_id, assigned_at DESC, id DESC)
        WHERE visit_appointment_id IS NOT NULL;

      CREATE INDEX handyman_assignment_responses_wo_idx
        ON handyman_assignment_responses (client_id, work_order_id, assigned_at DESC, id DESC)
        WHERE work_order_id IS NOT NULL;
    `);

    await client.query(`
      CREATE TABLE handyman_assignment_response_events (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        assignment_response_id  UUID NOT NULL
          REFERENCES handyman_assignment_responses (id),
        assignment_kind         TEXT NOT NULL
          CHECK (assignment_kind IN (
            'EXECUTION_SCOPE_CREW',
            'INSPECTION_VISIT',
            'WORK_ORDER'
          )),
        assignment_id           UUID NOT NULL,
        execution_scope_id      UUID,
        handyman_request_id     UUID,
        visit_appointment_id    UUID,
        work_order_id           UUID,
        event_type              TEXT NOT NULL
          CHECK (event_type IN (
            'ASSIGNMENT_ISSUED',
            'ACKNOWLEDGED_TERIMA',
            'DECLINED_TIDAK_BISA',
            'ASSIGNMENT_SUPERSEDED'
          )),
        response_status         TEXT NOT NULL
          CHECK (response_status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'SUPERSEDED')),
        response_code           TEXT
          CHECK (response_code IS NULL OR response_code IN ('TERIMA', 'TIDAK_BISA')),
        reason                  TEXT
          CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 1000),
        notes                   TEXT
          CHECK (notes IS NULL OR char_length(notes) <= 1000),
        actor_user_id           UUID NOT NULL REFERENCES users (id),
        idempotency_key         TEXT
          CHECK (idempotency_key IS NULL OR char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX handyman_assignment_resp_events_idem_idx
        ON handyman_assignment_response_events (client_id, assignment_id, event_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX handyman_assignment_resp_events_scope_idx
        ON handyman_assignment_response_events (client_id, execution_scope_id, occurred_at ASC, id ASC)
        WHERE execution_scope_id IS NOT NULL;

      CREATE INDEX handyman_assignment_resp_events_visit_idx
        ON handyman_assignment_response_events (client_id, visit_appointment_id, occurred_at ASC, id ASC)
        WHERE visit_appointment_id IS NOT NULL;

      CREATE INDEX handyman_assignment_resp_events_wo_idx
        ON handyman_assignment_response_events (client_id, work_order_id, occurred_at ASC, id ASC)
        WHERE work_order_id IS NOT NULL;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_assignment_resp_events_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman assignment response events are immutable and append-only.'
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER handyman_assignment_resp_events_no_write
        BEFORE UPDATE OR DELETE ON handyman_assignment_response_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_assignment_resp_events_block_mutation();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_assignment_resp_events_no_write
        ON handyman_assignment_response_events;
      DROP FUNCTION IF EXISTS handyman_assignment_resp_events_block_mutation();
      DROP TABLE IF EXISTS handyman_assignment_response_events;
      DROP TABLE IF EXISTS handyman_assignment_responses;
      DROP TABLE IF EXISTS handyman_assignment_response_policies;
    `);
  },
};
