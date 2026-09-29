import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-07 Arrival Verification PART 03B — per-Building geospatial
 * policy persistence (FROZEN decision
 * `CR-HM-07_GEOSPATIAL_AUTHORITY_DECISION.md` §1–§7/§10). Reference
 * coordinates/radius/accuracy/freshness are AUTHORIZED OPERATOR
 * CONFIGURATION — never auto-derived from device GPS/QR/reverse
 * geocoding/API.CO.ID/textual address/FM data. Building remains
 * identity/address authority; this table only REFERENCES it.
 *
 * Invariants (DB-enforced):
 *   1. physical sanity bounds ONLY: latitude -90..90, longitude
 *      -180..180, radius/accuracy/freshness positive — NO business
 *      default/maximum is invented;
 *   2. client_id structurally consistent with the building's property
 *      client (consistency trigger);
 *   3. exactly one ACTIVE policy per building (partial unique index);
 *   4. history-preserving: DELETE always blocked; UPDATE allowed ONLY
 *      for the lifecycle projection ACTIVE -> INACTIVE with every
 *      authority column unchanged (replacement = INACTIVE old + new
 *      ACTIVE INSERT, PART 03B service performs both atomically).
 */
export const migration0399CreateHandymanBuildingGeospatialPolicies:
  Migration = {
  id: '0399_create_handyman_building_geospatial_policies',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_building_geospatial_policies (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL
          REFERENCES clients (id),
        building_id            UUID NOT NULL
          REFERENCES buildings (id),
        reference_latitude     DOUBLE PRECISION NOT NULL,
        reference_longitude    DOUBLE PRECISION NOT NULL,
        geofence_radius_meters DOUBLE PRECISION NOT NULL,
        max_accuracy_meters    DOUBLE PRECISION NOT NULL,
        max_location_age_seconds INTEGER NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id     UUID NOT NULL
          REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bld_geo_policies_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_bld_geo_policies_latitude_check
          CHECK (
            reference_latitude >= -90 AND reference_latitude <= 90
          ),
        CONSTRAINT handyman_bld_geo_policies_longitude_check
          CHECK (
            reference_longitude >= -180 AND reference_longitude <= 180
          ),
        CONSTRAINT handyman_bld_geo_policies_radius_check
          CHECK (geofence_radius_meters > 0),
        CONSTRAINT handyman_bld_geo_policies_accuracy_check
          CHECK (max_accuracy_meters > 0),
        CONSTRAINT handyman_bld_geo_policies_freshness_check
          CHECK (max_location_age_seconds > 0)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_bld_geo_policies_one_active_idx
        ON handyman_building_geospatial_policies (building_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_bld_geo_policies_building_idx
        ON handyman_building_geospatial_policies (
          building_id, created_at
        )
    `);
    // Invariant 2: client_id must match the building's property client.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_bld_geo_policy_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        building_client UUID;
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
            'Handyman building geospatial policy client_id must match the building client.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bld_geo_policy_client_check
        BEFORE INSERT OR UPDATE
        ON handyman_building_geospatial_policies
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bld_geo_policy_client_consistency();
    `);
    // Invariant 4: immutable authority columns; the ONLY permitted
    // write is ACTIVE -> INACTIVE (replacement never overwrites).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_bld_geo_policy_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman building geospatial policies are history-preserving: rows cannot be deleted.';
        END IF;
        IF OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE'
           AND NEW.id = OLD.id
           AND NEW.client_id = OLD.client_id
           AND NEW.building_id = OLD.building_id
           AND NEW.reference_latitude = OLD.reference_latitude
           AND NEW.reference_longitude = OLD.reference_longitude
           AND NEW.geofence_radius_meters = OLD.geofence_radius_meters
           AND NEW.max_accuracy_meters = OLD.max_accuracy_meters
           AND NEW.max_location_age_seconds =
             OLD.max_location_age_seconds
           AND NEW.effective_from = OLD.effective_from
           AND NEW.created_by_user_id = OLD.created_by_user_id
           AND NEW.created_at = OLD.created_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman building geospatial policy columns are immutable authority: only ACTIVE -> INACTIVE is permitted (replacement inserts a new row).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bld_geo_policy_no_write
        BEFORE UPDATE OR DELETE
        ON handyman_building_geospatial_policies
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bld_geo_policy_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_bld_geo_policy_no_write
        ON handyman_building_geospatial_policies;
      DROP TRIGGER IF EXISTS handyman_bld_geo_policy_client_check
        ON handyman_building_geospatial_policies;
      DROP FUNCTION IF EXISTS
        handyman_bld_geo_policy_block_mutation;
      DROP FUNCTION IF EXISTS
        handyman_bld_geo_policy_client_consistency;
      DROP TABLE IF EXISTS handyman_building_geospatial_policies;
    `);
  },
};
