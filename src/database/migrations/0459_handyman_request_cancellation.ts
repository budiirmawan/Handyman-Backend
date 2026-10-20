import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-18 REQUEST-CANCEL-01 — Handyman request cancellation (J01 closure).
 *
 * The frozen CR-HM-03 F1 vocabulary had no cancellation exit: a request
 * that the tenant no longer wants could only be abandoned in place, and
 * the J01 journey was recorded as PARTIAL for exactly that reason
 * (`docs/handyman/HANDYMAN_E2E_PERSONA_CAPABILITY_MATRIX.md` §17 item 1).
 * This migration adds the missing terminal state plus its append-only fact.
 *
 * Policy frozen by this CR (documented in
 * `docs/handyman/CR-HM-18_FULL_CAPABILITY_CLOSURE.md`):
 *
 *   - `CANCELLED` is terminal, reachable from every pre-commitment state
 *     (INTAKE, TRIAGE, INSPECTION_REQUIRED, DIAGNOSIS,
 *     READY_FOR_NEXT_STEP);
 *   - it is NOT reachable from `REFERRED` (already terminal) or from
 *     another `CANCELLED`;
 *   - it is refused once the request owns an execution scope, i.e. once a
 *     quotation has been approved and work is commercially committed.
 *     Post-commitment endings stay with the existing scope/void/variation
 *     authorities (no second, parallel cancellation path is invented).
 *
 * `handyman_request_cancellations` is append-only (BEFORE UPDATE/DELETE
 * trigger, same guard family as 0380/0381/0382/0383); the request row's
 * status projection is the only mutated column, through the repository's
 * existing `updateStatus` seam.
 */
export const migration0459HandymanRequestCancellation: Migration = {
  id: '0459_handyman_request_cancellation',
  async up(client: PoolClient): Promise<void> {
    // 1. Bounded status vocabulary + CANCELLED (additive re-add).
    await client.query(`
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_status_check
        CHECK (status IN (
          'INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS',
          'READY_FOR_NEXT_STEP', 'REFERRED', 'CANCELLED'
        ))
    `);

    // 2. Append-only cancellation fact.
    await client.query(`
      CREATE TABLE handyman_request_cancellations (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        handyman_request_id      UUID NOT NULL,
        channel_attribution_id   UUID NOT NULL
          REFERENCES handyman_channel_attributions (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        previous_status          TEXT NOT NULL,
        reason                   TEXT NOT NULL,
        cancelled_by_user_id     UUID NOT NULL REFERENCES users (id),
        idempotency_key          VARCHAR(200) NOT NULL,
        occurred_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_request_cancellations_previous_status_check
          CHECK (previous_status IN (
            'INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS',
            'READY_FOR_NEXT_STEP'
          )),
        CONSTRAINT handyman_request_cancellations_reason_check
          CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
        CONSTRAINT handyman_request_cancellations_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_request_cancellations_request_unique
          UNIQUE (handyman_request_id),
        CONSTRAINT handyman_request_cancellations_key_unique
          UNIQUE (idempotency_key),
        CONSTRAINT handyman_request_cancellations_request_scope_fk
          FOREIGN KEY (handyman_request_id, client_id)
            REFERENCES handyman_service_requests (id, client_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_request_cancellations_scope_idx
        ON handyman_request_cancellations (client_id, occurred_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_request_cancellations_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman request cancellation records are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_cancellations_no_update
        BEFORE UPDATE ON handyman_request_cancellations
        FOR EACH ROW
        EXECUTE FUNCTION handyman_request_cancellations_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_request_cancellations_no_delete
        BEFORE DELETE ON handyman_request_cancellations
        FOR EACH ROW
        EXECUTE FUNCTION handyman_request_cancellations_block_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_request_cancellations CASCADE',
    );
    await client.query(`
      ALTER TABLE handyman_service_requests
        DROP CONSTRAINT IF EXISTS handyman_service_requests_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_requests
        ADD CONSTRAINT handyman_service_requests_status_check
        CHECK (status IN (
          'INTAKE', 'TRIAGE', 'INSPECTION_REQUIRED', 'DIAGNOSIS',
          'READY_FOR_NEXT_STEP', 'REFERRED'
        ))
    `);
  },
};
