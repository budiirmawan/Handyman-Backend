import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-07 Arrival Verification PART 01 — arrival challenge
 * persistence + DB invariants ONLY (FROZEN governance
 * `CR-HM-07_START_GOVERNANCE.md` §F; CR-HM-04 activation certification
 * consumer contract).
 *
 * Server-authoritative short-lived single-use challenge binding an
 * authenticated actor to exactly one HANDYMAN_EXECUTION_SCOPE for the
 * later layered arrival verification (PART 02+). NO QR/location-token
 * verification fields, NO GPS/geofence, NO arrival VERIFIED/FAILED
 * result, NO work-session/attendance/scheduling/payment/BAST/FM
 * fields (firewall). Expected location is NOT persisted here —
 * Execution Scope remains location authority.
 *
 * Invariants (DB-enforced):
 *   1. execution_scope_id FKs the authoritative
 *      handyman_execution_scopes; assignment_id FKs the CR-HM-04
 *      assignment authority (snapshot binding at issue time);
 *   2. client_id structurally consistent with scope + assignment
 *      (same consistency-trigger pattern as 0396);
 *   3. raw challenge token is NEVER persisted — token_hash only;
 *   4. at most one live PENDING challenge per
 *      (execution_scope_id, actor_user_id) — partial unique index,
 *      concurrency-safe creation backstop;
 *   5. expires_at is server-set (service issues NOW() + 120 seconds);
 *      consumed_at is NULL unless status='CONSUMED';
 *   6. identity/binding immutable: DELETE always blocked; UPDATE
 *      allowed ONLY for the minimum lifecycle projections
 *      PENDING -> CONSUMED (sets consumed_at) and
 *      PENDING -> EXPIRED (nothing else changes).
 */
export const migration0397CreateHandymanArrivalChallenges: Migration = {
  id: '0397_create_handyman_arrival_challenges',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_arrival_challenges (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id    UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        assignment_id         UUID NOT NULL
          REFERENCES handyman_execution_scope_assignments (id),
        actor_user_id         UUID NOT NULL
          REFERENCES users (id),
        token_hash            TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'PENDING',
        expires_at            TIMESTAMPTZ NOT NULL,
        consumed_at           TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_arrival_challenges_status_check
          CHECK (status IN ('PENDING', 'CONSUMED', 'EXPIRED')),
        CONSTRAINT handyman_arrival_challenges_consumed_at_check
          CHECK (consumed_at IS NULL OR status = 'CONSUMED')
      )
    `);
    // Invariant 4: one live PENDING per (scope, actor) — the
    // concurrency backstop; the service turns violations into the
    // deterministic bounded live-conflict behavior.
    await client.query(`
      CREATE UNIQUE INDEX handyman_arrival_challenges_one_pending_idx
        ON handyman_arrival_challenges (execution_scope_id, actor_user_id)
        WHERE status = 'PENDING'
    `);
    await client.query(`
      CREATE INDEX handyman_arrival_challenges_scope_idx
        ON handyman_arrival_challenges (execution_scope_id, created_at)
    `);
    // Invariant 2: client_id structural consistency with the two
    // referenced authorities (scope / assignment).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_arrival_challenge_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client      UUID;
        assignment_client UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        SELECT client_id INTO assignment_client
          FROM handyman_execution_scope_assignments
          WHERE id = NEW.assignment_id;
        IF scope_client IS NULL OR assignment_client IS NULL THEN
          -- Absent referents fall through to the FK constraints.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client
           OR NEW.client_id IS DISTINCT FROM assignment_client THEN
          RAISE EXCEPTION
            'Handyman arrival challenge client_id must match the execution scope and assignment client (cross-client binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_arrival_challenge_client_check
        BEFORE INSERT OR UPDATE ON handyman_arrival_challenges
        FOR EACH ROW
        EXECUTE FUNCTION handyman_arrival_challenge_client_consistency();
    `);
    // Invariant 6: immutable identity/binding/token material; the
    // ONLY permitted writes are the two lifecycle projections.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_arrival_challenge_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman arrival challenges are append-only: history rows cannot be deleted.';
        END IF;
        IF OLD.status = 'PENDING' AND NEW.status = 'CONSUMED'
           AND NEW.consumed_at IS NOT NULL
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.execution_scope_id = OLD.execution_scope_id
           AND NEW.assignment_id = OLD.assignment_id
           AND NEW.actor_user_id = OLD.actor_user_id
           AND NEW.token_hash IS NOT DISTINCT FROM OLD.token_hash
           AND NEW.expires_at = OLD.expires_at
           AND NEW.created_at = OLD.created_at THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'PENDING' AND NEW.status = 'EXPIRED'
           AND NEW.consumed_at IS NULL
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.execution_scope_id = OLD.execution_scope_id
           AND NEW.assignment_id = OLD.assignment_id
           AND NEW.actor_user_id = OLD.actor_user_id
           AND NEW.token_hash IS NOT DISTINCT FROM OLD.token_hash
           AND NEW.expires_at = OLD.expires_at
           AND NEW.created_at = OLD.created_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman arrival challenge identity and token material are immutable: only PENDING -> CONSUMED or PENDING -> EXPIRED is permitted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_arrival_challenge_no_write
        BEFORE UPDATE OR DELETE ON handyman_arrival_challenges
        FOR EACH ROW
        EXECUTE FUNCTION handyman_arrival_challenge_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_arrival_challenge_no_write
        ON handyman_arrival_challenges;
      DROP TRIGGER IF EXISTS handyman_arrival_challenge_client_check
        ON handyman_arrival_challenges;
      DROP FUNCTION IF EXISTS
        handyman_arrival_challenge_block_mutation;
      DROP FUNCTION IF EXISTS
        handyman_arrival_challenge_client_consistency;
      DROP TABLE IF EXISTS handyman_arrival_challenges;
    `);
  },
};
