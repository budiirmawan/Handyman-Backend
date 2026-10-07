import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CUSTOMER-CONTEXT-01 PART 02 — explicit Customer Care property grants.
 * A grant is NOT tenant representation, occupancy, or a local-user session.
 * Client is derived through properties, never copied into a second authority.
 * Revoked rows remain as history; regrant creates a new row.
 */
export const migration0428CreateHandymanCarePropertyGrants: Migration = {
  id: '0428_create_handyman_care_property_grants',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_care_property_grants (
        id                 UUID PRIMARY KEY,
        care_actor_id      UUID NOT NULL REFERENCES handyman_handoff_care_actors (id),
        property_id        UUID NOT NULL REFERENCES properties (id),
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        granted_by_user_id UUID NOT NULL REFERENCES users (id),
        granted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_by_user_id UUID REFERENCES users (id),
        revoked_at         TIMESTAMPTZ,
        CONSTRAINT handyman_care_property_grants_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT handyman_care_property_grants_revoke_check
          CHECK ((status = 'ACTIVE' AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
              OR (status = 'REVOKED' AND revoked_by_user_id IS NOT NULL
                  AND revoked_at IS NOT NULL AND revoked_at >= granted_at))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_care_property_grants_active_unique
        ON handyman_care_property_grants (care_actor_id, property_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX handyman_care_property_grants_property_idx
        ON handyman_care_property_grants (property_id, status);
    `);
    // Only the ACTIVE -> REVOKED transition is permitted; no delete or
    // retrospective edits to the original grant/revocation provenance.
    await client.query(`
      CREATE FUNCTION handyman_care_property_grants_guard() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Care property grant history cannot be deleted.'
            USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND NOT (
          OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED'
          AND NEW.id = OLD.id AND NEW.care_actor_id = OLD.care_actor_id
          AND NEW.property_id = OLD.property_id
          AND NEW.granted_by_user_id = OLD.granted_by_user_id
          AND NEW.granted_at = OLD.granted_at
        ) THEN
          RAISE EXCEPTION 'Only care property grant revocation is permitted.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $guard$;
      CREATE TRIGGER handyman_care_property_grants_guard
        BEFORE UPDATE OR DELETE ON handyman_care_property_grants
        FOR EACH ROW EXECUTE FUNCTION handyman_care_property_grants_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_care_property_grants');
    await client.query('DROP FUNCTION IF EXISTS handyman_care_property_grants_guard()');
  },
};
