import type { Migration } from './types';

/** Separate credential/replay store. No User, PIC, grant or occupancy authority. */
export const migration0429CreateHandymanCareWorkspaceSessions: Migration = {
  id: '0429_create_handyman_care_workspace_sessions',
  async up(client) {
    await client.query(`
      CREATE TABLE handyman_care_workspace_sessions (
        id UUID PRIMARY KEY,
        integration_id UUID NOT NULL REFERENCES handyman_handoff_integrations(id),
        care_actor_id UUID NOT NULL REFERENCES handyman_handoff_care_actors(id),
        assertion_id TEXT NOT NULL CHECK (char_length(assertion_id) BETWEEN 1 AND 128),
        token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ CHECK (revoked_at IS NULL OR revoked_at >= created_at),
        CONSTRAINT handyman_care_workspace_assertion_unique UNIQUE (integration_id, assertion_id),
        CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes')
      );
      CREATE INDEX handyman_care_workspace_actor_idx
        ON handyman_care_workspace_sessions(care_actor_id);
      CREATE INDEX handyman_care_workspace_integration_idx
        ON handyman_care_workspace_sessions(integration_id);

      -- Permanent invalidation at the authority transition, even if no token
      -- is used while inactive. Reactivation must never resurrect sessions.
      CREATE FUNCTION handyman_care_workspace_invalidate_actor() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status <> 'ACTIVE' OR NEW.integration_id <> OLD.integration_id
           OR NEW.actor_reference <> OLD.actor_reference THEN
          UPDATE handyman_care_workspace_sessions SET revoked_at = clock_timestamp()
            WHERE care_actor_id = OLD.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER handyman_care_workspace_invalidate_actor
        AFTER UPDATE ON handyman_handoff_care_actors FOR EACH ROW
        EXECUTE FUNCTION handyman_care_workspace_invalidate_actor();
      CREATE FUNCTION handyman_care_workspace_invalidate_integration() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status <> 'ACTIVE' OR NEW.actor_capability <> 'CUSTOMER_CARE'
           OR NEW.integration_code <> OLD.integration_code THEN
          UPDATE handyman_care_workspace_sessions SET revoked_at = clock_timestamp()
            WHERE integration_id = OLD.id AND revoked_at IS NULL;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER handyman_care_workspace_invalidate_integration
        AFTER UPDATE ON handyman_handoff_integrations FOR EACH ROW
        EXECUTE FUNCTION handyman_care_workspace_invalidate_integration();

      -- Session identity/expiry and replay tombstones are immutable. Only
      -- first revocation is writable; there is no renewal or replay cleanup.
      CREATE FUNCTION handyman_care_workspace_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Workspace replay history cannot be deleted.' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
           OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
          RAISE EXCEPTION 'Only workspace revocation is permitted.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER handyman_care_workspace_guard BEFORE UPDATE OR DELETE
        ON handyman_care_workspace_sessions FOR EACH ROW
        EXECUTE FUNCTION handyman_care_workspace_guard();
    `);
  },
  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_care_workspace_invalidate_actor ON handyman_handoff_care_actors;
      DROP TRIGGER IF EXISTS handyman_care_workspace_invalidate_integration ON handyman_handoff_integrations;
      DROP FUNCTION IF EXISTS handyman_care_workspace_invalidate_actor();
      DROP FUNCTION IF EXISTS handyman_care_workspace_invalidate_integration();
      DROP TABLE IF EXISTS handyman_care_workspace_sessions;
      DROP FUNCTION IF EXISTS handyman_care_workspace_guard();
    `);
  },
};
