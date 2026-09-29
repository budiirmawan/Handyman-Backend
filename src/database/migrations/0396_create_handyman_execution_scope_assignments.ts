import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-04 Execution Scope Assignment Activation PART A — persistence
 * + DB invariants ONLY (FROZEN governance
 * `CR-HM-04_EXECUTION_SCOPE_ASSIGNMENT_ACTIVATION.md` §1–§8).
 *
 * Provider-authored crew assignment binding to exactly one CR-HM-06
 * Execution Scope (targetType = HANDYMAN_EXECUTION_SCOPE). No service,
 * no reassignment transaction, no Lead snapshot, no HTTP — PART B/C
 * own those. NO scheduling/arrival/QR/geofence/work-session/
 * attendance/payment/BAST/FM fields (firewall §7).
 *
 * Invariants (DB-enforced):
 *   1. execution_scope_id FKs the authoritative
 *      handyman_execution_scopes (PART 06 target authority);
 *   2. client_id is structurally consistent with scope/provider/crew
 *      via a consistency trigger (the referenced tables predate the
 *      composite-FK precedent and carry no UNIQUE (id, client_id)
 *      keys, so the trigger is the additive equivalent);
 *   3. provider context + crew FK the existing CR-HM-04 authorities;
 *   4. exactly one ACTIVE assignment per execution scope (partial
 *      unique index, 0393-class);
 *   5. supersedes_assignment_id self-references, is nullable for a
 *      first assignment, and can never self-supersede;
 *   6. identity/provenance immutable: DELETE always blocked; UPDATE
 *      allowed ONLY for the minimum lifecycle ACTIVE -> SUPERSEDED
 *      with every other column unchanged (PART B performs it).
 *   7. NO Lead snapshot column — lead resolves from CR-HM-04 crew
 *      authority only.
 */
export const migration0396CreateHandymanExecutionScopeAssignments:
  Migration = {
  id: '0396_create_handyman_execution_scope_assignments',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_execution_scope_assignments (
        id                            UUID PRIMARY KEY,
        client_id                     UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id            UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        handyman_provider_context_id  UUID NOT NULL
          REFERENCES handyman_provider_contexts (id),
        handyman_crew_id              UUID NOT NULL
          REFERENCES handyman_work_crews (id),
        status                        TEXT NOT NULL DEFAULT 'ACTIVE',
        assigned_by_user_id           UUID NOT NULL
          REFERENCES users (id),
        assigned_at                   TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),
        supersedes_assignment_id      UUID
          REFERENCES handyman_execution_scope_assignments (id),
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_es_assignments_status_check
          CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
        CONSTRAINT handyman_es_assignments_no_self_supersede
          CHECK (
            supersedes_assignment_id IS NULL
            OR supersedes_assignment_id <> id
          )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_es_assignments_one_active_idx
        ON handyman_execution_scope_assignments (execution_scope_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_es_assignments_client_idx
        ON handyman_execution_scope_assignments (client_id, assigned_at)
    `);
    // Invariant 2: client_id structural consistency with the three
    // referenced authorities (scope / provider context / crew).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_es_assignment_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client    UUID;
        provider_client UUID;
        crew_client     UUID;
      BEGIN
        SELECT client_id INTO scope_client
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        SELECT client_id INTO provider_client
          FROM handyman_provider_contexts
          WHERE id = NEW.handyman_provider_context_id;
        SELECT client_id INTO crew_client
          FROM handyman_work_crews
          WHERE id = NEW.handyman_crew_id;
        IF scope_client IS NULL OR provider_client IS NULL
           OR crew_client IS NULL THEN
          -- Absent referents fall through to the FK constraints.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client
           OR NEW.client_id IS DISTINCT FROM provider_client
           OR NEW.client_id IS DISTINCT FROM crew_client THEN
          RAISE EXCEPTION
            'Handyman execution scope assignment client_id must match the scope, provider context, and crew client (cross-client binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_es_assignment_client_check
        BEFORE INSERT OR UPDATE ON handyman_execution_scope_assignments
        FOR EACH ROW
        EXECUTE FUNCTION handyman_es_assignment_client_consistency();
    `);
    // Invariant 6: immutable identity/history; the ONLY permitted
    // write is the status transition ACTIVE -> SUPERSEDED.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_es_assignment_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman execution scope assignment history is immutable: delete is forbidden.';
        END IF;
        IF OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED'
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.execution_scope_id = OLD.execution_scope_id
           AND NEW.handyman_provider_context_id =
               OLD.handyman_provider_context_id
           AND NEW.handyman_crew_id = OLD.handyman_crew_id
           AND NEW.assigned_by_user_id = OLD.assigned_by_user_id
           AND NEW.assigned_at = OLD.assigned_at
           AND NEW.supersedes_assignment_id IS NOT DISTINCT FROM
               OLD.supersedes_assignment_id
           AND NEW.created_at = OLD.created_at
        THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman execution scope assignment identity and provenance are immutable: only ACTIVE -> SUPERSEDED is permitted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_es_assignment_no_write
        BEFORE UPDATE OR DELETE ON handyman_execution_scope_assignments
        FOR EACH ROW
        EXECUTE FUNCTION handyman_es_assignment_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_es_assignment_no_write
        ON handyman_execution_scope_assignments;
      DROP TRIGGER IF EXISTS handyman_es_assignment_client_check
        ON handyman_execution_scope_assignments;
      DROP FUNCTION IF EXISTS
        handyman_es_assignment_block_mutation;
      DROP FUNCTION IF EXISTS
        handyman_es_assignment_client_consistency;
      DROP TABLE IF EXISTS handyman_execution_scope_assignments;
    `);
  },
};
