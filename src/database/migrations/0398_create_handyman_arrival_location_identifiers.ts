import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-07 Arrival Verification PART 02 — opaque Handyman location
 * identifier registry (FROZEN governance §C/§G): QR values are opaque
 * presence identifiers ONLY, resolved server-side to an authoritative
 * location chain and compared against the immutable Execution Scope
 * snapshot. QR alone NEVER proves arrival; NO verdicts, NO geofence/
 * GPS, NO work-session/check-in, NO FM patrol/checkpoint semantics.
 *
 * Invariants (DB-enforced):
 *   1. chain references the EXISTING location masters (buildings/
 *      floors/areas/rooms/spaces) — they remain the only location
 *      authority;
 *   2. client_id derives from the building's property client
 *      (consistency trigger); caller can never author it;
 *   3. chain completeness (building-rooted): floor NULL ⇒ all deeper
 *      NULL; area requires floor; room requires area; space requires
 *      room — and each link must really belong to its parent
 *      (hierarchy trigger);
 *   4. raw opaque value is NEVER persisted — opaque_code_hash only,
 *      globally unique (existing secure-identifier convention);
 *   5. DELETE always blocked; UPDATE allowed ONLY for the lifecycle
 *      projection ACTIVE -> INACTIVE with every other column
 *      unchanged (registry deactivation audit path).
 */
export const migration0398CreateHandymanArrivalLocationIdentifiers:
  Migration = {
  id: '0398_create_handyman_arrival_location_identifiers',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_arrival_location_identifiers (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        opaque_code_hash   TEXT NOT NULL,
        building_id        UUID NOT NULL
          REFERENCES buildings (id),
        floor_id           UUID
          REFERENCES floors (id),
        area_id            UUID
          REFERENCES areas (id),
        room_id            UUID
          REFERENCES rooms (id),
        space_id           UUID
          REFERENCES spaces (id),
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_arrival_location_ids_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_arrival_location_ids_floor_chain
          CHECK (
            floor_id IS NOT NULL
            OR (area_id IS NULL AND room_id IS NULL AND space_id IS NULL)
          ),
        CONSTRAINT handyman_arrival_location_ids_area_chain
          CHECK (area_id IS NULL OR floor_id IS NOT NULL),
        CONSTRAINT handyman_arrival_location_ids_room_chain
          CHECK (room_id IS NULL OR area_id IS NOT NULL),
        CONSTRAINT handyman_arrival_location_ids_space_chain
          CHECK (space_id IS NULL OR room_id IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_arrival_location_ids_hash_idx
        ON handyman_arrival_location_identifiers (opaque_code_hash)
    `);
    await client.query(`
      CREATE INDEX handyman_arrival_location_ids_client_idx
        ON handyman_arrival_location_identifiers (client_id, status)
    `);
    // Invariants 2 + 3: building-rooted hierarchy + client coherence.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_arrival_location_id_chain_consistency()
      RETURNS trigger AS $$
      DECLARE
        building_client UUID;
        parent          UUID;
      BEGIN
        SELECT p.client_id INTO building_client
          FROM buildings b
          JOIN properties p ON p.id = b.property_id
          WHERE b.id = NEW.building_id;
        IF building_client IS NULL THEN
          -- Absent building falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM building_client THEN
          RAISE EXCEPTION
            'Handyman arrival location identifier client_id must match the building client.';
        END IF;
        IF NEW.floor_id IS NOT NULL THEN
          SELECT building_id INTO parent FROM floors
            WHERE id = NEW.floor_id;
          IF parent IS NOT NULL AND parent IS DISTINCT FROM NEW.building_id THEN
            RAISE EXCEPTION
              'Handyman arrival location identifier floor must belong to its building.';
          END IF;
        END IF;
        IF NEW.area_id IS NOT NULL THEN
          SELECT floor_id INTO parent FROM areas
            WHERE id = NEW.area_id;
          IF parent IS NOT NULL AND parent IS DISTINCT FROM NEW.floor_id THEN
            RAISE EXCEPTION
              'Handyman arrival location identifier area must belong to its floor.';
          END IF;
        END IF;
        IF NEW.room_id IS NOT NULL THEN
          SELECT area_id INTO parent FROM rooms
            WHERE id = NEW.room_id;
          IF parent IS NOT NULL AND parent IS DISTINCT FROM NEW.area_id THEN
            RAISE EXCEPTION
              'Handyman arrival location identifier room must belong to its area.';
          END IF;
        END IF;
        IF NEW.space_id IS NOT NULL THEN
          SELECT room_id INTO parent FROM spaces
            WHERE id = NEW.space_id;
          IF parent IS NOT NULL AND parent IS DISTINCT FROM NEW.room_id THEN
            RAISE EXCEPTION
              'Handyman arrival location identifier space must belong to its room.';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_arrival_location_id_chain_check
        BEFORE INSERT OR UPDATE ON handyman_arrival_location_identifiers
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_arrival_location_id_chain_consistency();
    `);
    // Invariant 5: immutable binding/material; the ONLY permitted
    // write is ACTIVE -> INACTIVE.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_arrival_location_id_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman arrival location identifiers are append-only: rows cannot be deleted.';
        END IF;
        IF OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE'
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.opaque_code_hash = OLD.opaque_code_hash
           AND NEW.building_id = OLD.building_id
           AND NEW.floor_id IS NOT DISTINCT FROM OLD.floor_id
           AND NEW.area_id IS NOT DISTINCT FROM OLD.area_id
           AND NEW.room_id IS NOT DISTINCT FROM OLD.room_id
           AND NEW.space_id IS NOT DISTINCT FROM OLD.space_id
           AND NEW.created_at = OLD.created_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman arrival location identifier binding and code material are immutable: only ACTIVE -> INACTIVE is permitted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_arrival_location_id_no_write
        BEFORE UPDATE OR DELETE ON handyman_arrival_location_identifiers
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_arrival_location_id_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_arrival_location_id_no_write
        ON handyman_arrival_location_identifiers;
      DROP TRIGGER IF EXISTS handyman_arrival_location_id_chain_check
        ON handyman_arrival_location_identifiers;
      DROP FUNCTION IF EXISTS
        handyman_arrival_location_id_block_mutation;
      DROP FUNCTION IF EXISTS
        handyman_arrival_location_id_chain_consistency;
      DROP TABLE IF EXISTS handyman_arrival_location_identifiers;
    `);
  },
};
