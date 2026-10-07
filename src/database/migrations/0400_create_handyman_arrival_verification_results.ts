import type { Migration } from './types';

/**
 * CR-HM-07 PART 04A — handyman_arrival_verification_results: terminal
 * arrival-result persistence per the FROZEN PART 04 governance
 * (docs/handyman/CR-HM-07_PART04_ARRIVAL_RESULT_GOVERNANCE.md).
 *
 * Stores ONLY the terminal evaluation's immutable snapshot: identity
 * bindings (scope/assignment/actor/challenge), expected-location
 * snapshot, QR/device/geofence signal snapshots, optional normalized
 * reverse-geocode corroboration fields (bounded DTO fields only —
 * NEVER raw provider payloads or secret material), terminal status,
 * bounded primary reason, evaluatedAt, createdAt.
 *
 * Invariants (governance §9/§14/§15/§16):
 *   - status CHECK == exactly VERIFIED/FAILED/MANUAL_REVIEW_REQUIRED/
 *     EXPIRED;
 *   - primary_reason CHECK == exactly the frozen bounded codes, paired
 *     with status (no free-form authoritative reason text exists);
 *   - UNIQUE (challenge_id) — exactly one terminal result per
 *     challenge;
 *   - append-only: DELETE always blocked; UPDATE entirely blocked
 *     (immutable after INSERT; terminal results never mutate);
 *   - client/binding consistency trigger: scope, assignment and
 *     challenge share one client AND one execution scope (the PART 01
 *     trigger pattern extended); geospatial policy (when present)
 *     shares the same client.
 *
 * Persistence only: NO evaluator, NO challenge consumption, NO QR/
 * geofence evaluation, NO API.CO.ID call, NO HTTP/OpenAPI, NO
 * work-session/attendance/billing/BAST/FM semantics — and no raw
 * provider payload or API key column exists.
 */
export const migration0400CreateHandymanArrivalVerificationResults:
Migration = {
  id: '0400_create_handyman_arrival_verification_results',
  async up(client) {
    await client.query(`
      CREATE TABLE handyman_arrival_verification_results (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id              UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        assignment_id                   UUID NOT NULL
          REFERENCES handyman_execution_scope_assignments (id),
        actor_user_id                   UUID NOT NULL
          REFERENCES users (id),
        challenge_id                    UUID NOT NULL
          REFERENCES handyman_arrival_challenges (id),
        expected_building_id            UUID NOT NULL
          REFERENCES buildings (id),
        expected_floor_id               UUID
          REFERENCES floors (id),
        expected_area_id                UUID
          REFERENCES areas (id),
        expected_room_id                UUID
          REFERENCES rooms (id),
        expected_space_id               UUID
          REFERENCES spaces (id),
        qr_signal                       TEXT NOT NULL,
        device_latitude                 NUMERIC,
        device_longitude                NUMERIC,
        device_accuracy_meters          NUMERIC,
        device_captured_at              TIMESTAMPTZ,
        geofence_signal                 TEXT,
        distance_meters                 NUMERIC,
        geospatial_policy_id            UUID
          REFERENCES handyman_building_geospatial_policies (id),
        reverse_geocode_status          TEXT,
        reverse_geocode_display_name    TEXT,
        reverse_geocode_province        TEXT,
        reverse_geocode_regency         TEXT,
        reverse_geocode_district        TEXT,
        reverse_geocode_village         TEXT,
        reverse_geocode_postal_code     TEXT,
        reverse_geocode_provider_place_id TEXT,
        status                          TEXT NOT NULL,
        primary_reason                  TEXT NOT NULL,
        evaluated_at                    TIMESTAMPTZ NOT NULL,
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT hmar_status_check
          CHECK (status IN
            ('VERIFIED', 'FAILED', 'MANUAL_REVIEW_REQUIRED', 'EXPIRED')),
        CONSTRAINT hmar_reason_check
          CHECK (
            (status = 'VERIFIED' AND
             primary_reason = 'ALL_POSITIVE_EVIDENCE')
            OR
            (status = 'FAILED' AND primary_reason IN
             ('QR_MISMATCH', 'GEOFENCE_OUTSIDE',
              'ACTOR_ASSIGNMENT_INVALID'))
            OR
            (status = 'MANUAL_REVIEW_REQUIRED' AND primary_reason IN
             ('QR_UNKNOWN', 'QR_INACTIVE', 'NO_GEOSPATIAL_POLICY',
              'LOW_ACCURACY', 'GEOFENCE_UNAVAILABLE'))
            OR
            (status = 'EXPIRED' AND
             primary_reason = 'CHALLENGE_EXPIRED')
          ),
        CONSTRAINT hmar_qr_signal_check
          CHECK (qr_signal IN ('MATCH', 'MISMATCH', 'UNKNOWN', 'INACTIVE')),
        CONSTRAINT hmar_geofence_signal_check
          CHECK (geofence_signal IS NULL OR geofence_signal IN
            ('INSIDE', 'OUTSIDE', 'LOW_ACCURACY', 'UNAVAILABLE')),
        CONSTRAINT hmar_reverse_geocode_status_check
          CHECK (reverse_geocode_status IS NULL OR reverse_geocode_status IN
            ('AVAILABLE', 'REVERSE_GEOCODE_UNAVAILABLE',
             'REVERSE_GEOCODE_AUTH_FAILURE'))
      )
    `);
    // Governance §15: exactly one authoritative terminal result per
    // challenge.
    await client.query(`
      CREATE UNIQUE INDEX handyman_arrival_results_one_per_challenge_idx
        ON handyman_arrival_verification_results (challenge_id)
    `);
    await client.query(`
      CREATE INDEX handyman_arrival_results_scope_idx
        ON handyman_arrival_verification_results
          (execution_scope_id, created_at)
    `);
    // Client + binding consistency: scope, assignment and challenge
    // must agree on one client and one execution scope; the referenced
    // geospatial policy (if any) shares the same client. Absent
    // referents fall through to the FK constraints (PART 01 pattern).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_arrival_result_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client      UUID;
        assignment_client UUID;
        assignment_scope  UUID;
        challenge_client  UUID;
        challenge_scope   UUID;
        challenge_actor   UUID;
        policy_client     UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        SELECT client_id, execution_scope_id
            INTO assignment_client, assignment_scope
          FROM handyman_execution_scope_assignments
          WHERE id = NEW.assignment_id;
        SELECT client_id, execution_scope_id, actor_user_id
            INTO challenge_client, challenge_scope, challenge_actor
          FROM handyman_arrival_challenges
          WHERE id = NEW.challenge_id;
        IF NEW.geospatial_policy_id IS NOT NULL THEN
          SELECT client_id INTO policy_client
            FROM handyman_building_geospatial_policies
            WHERE id = NEW.geospatial_policy_id;
          IF policy_client IS NOT NULL
             AND NEW.client_id IS DISTINCT FROM policy_client THEN
            RAISE EXCEPTION
              'Handyman arrival result client_id must match the geospatial policy client (cross-client binding is forbidden).';
          END IF;
        END IF;
        IF scope_client IS NULL OR assignment_client IS NULL
           OR challenge_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client
           OR NEW.client_id IS DISTINCT FROM assignment_client
           OR NEW.client_id IS DISTINCT FROM challenge_client THEN
          RAISE EXCEPTION
            'Handyman arrival result client_id must match the execution scope, assignment and challenge client (cross-client binding is forbidden).';
        END IF;
        IF assignment_scope IS DISTINCT FROM NEW.execution_scope_id
           OR challenge_scope IS DISTINCT FROM NEW.execution_scope_id THEN
          RAISE EXCEPTION
            'Handyman arrival result assignment_id and challenge_id must bind to the same execution scope.';
        END IF;
        IF NEW.actor_user_id IS DISTINCT FROM challenge_actor THEN
          RAISE EXCEPTION
            'Handyman arrival result actor_user_id must equal the challenge Lead actor (authoritative binding).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_arrival_result_client_check
        BEFORE INSERT OR UPDATE ON handyman_arrival_verification_results
        FOR EACH ROW
        EXECUTE FUNCTION handyman_arrival_result_client_consistency();
    `);
    // Governance §16: the terminal result is an immutable audit
    // snapshot — DELETE is always forbidden and UPDATE is entirely
    // blocked (no lifecycle projections exist for results).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_arrival_result_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman arrival verification results are append-only: terminal results cannot be deleted.';
        END IF;
        RAISE EXCEPTION
          'Handyman arrival verification results are immutable after INSERT: terminal results cannot be updated.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_arrival_result_block_mutation_trigger
        BEFORE UPDATE OR DELETE ON handyman_arrival_verification_results
        FOR EACH ROW
        EXECUTE FUNCTION handyman_arrival_result_block_mutation();
    `);
  },
  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_arrival_result_block_mutation_trigger
        ON handyman_arrival_verification_results
    `);
    await client.query(
      `DROP FUNCTION IF EXISTS handyman_arrival_result_block_mutation`,
    );
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_arrival_result_client_check
        ON handyman_arrival_verification_results
    `);
    await client.query(
      `DROP FUNCTION IF EXISTS handyman_arrival_result_client_consistency`,
    );
    await client.query(
      `DROP TABLE IF EXISTS handyman_arrival_verification_results`,
    );
  },
};
