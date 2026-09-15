import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21A — shared Incident foundation.
 *
 * ONE Incident table serves Operational Incident (BE-21B), Asset Failure /
 * Defect (BE-21C), and Finding Escalation (BE-21D). The `incident_type`
 * discriminator distinguishes them; there is deliberately no second Incident
 * engine, no Defect table, and no Corrective Action table.
 *
 * Typed bindings are NOT part of this PART:
 *   - BE-21C will add the Asset / Equipment typed binding for ASSET_FAILURE.
 *   - BE-21D will add the BE-09 Finding typed binding for FINDING_ESCALATION.
 * Both will reference the existing BE-05 / BE-09 records; neither may
 * duplicate them.
 *
 * BE-09 remains the sole authority for Finding lifecycle and workflow. This
 * table holds no Finding state, no workflow engine, no verification, no
 * corrective action, no responsible person, no due date, and no closure —
 * each of those belongs to a later BE-21 PART and several of them reuse the
 * shared BE-07 / BE-09 foundations rather than new tables.
 *
 * `client_id` is DERIVED by the service through Building → Property → Client
 * (BE-02) and is never accepted from the API consumer, so Client / Building
 * isolation can never drift.
 *
 * LOCATION is an OPTIONAL refinement of the authoritative BE-04 structure.
 * `building_id` is the isolation context and is always present; a NULL
 * `location_type` therefore means "Building level, no finer location". When
 * `location_type` is set, exactly one matching BE-04 reference must be set —
 * enforced here rather than trusted from the caller. No location names or
 * hierarchy are copied; only references are stored.
 *
 * LIFECYCLE is intentionally minimal for the foundation: REPORTED → CANCELLED.
 * Operational progression, investigation, corrective action, verification and
 * closure arrive in later BE-21 PARTs and remain backend-authoritative.
 */
export const migration0214CreateIncidents: Migration = {
  id: '0214_create_incidents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE incidents (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        incident_number        TEXT NOT NULL,
        incident_type          TEXT NOT NULL,
        title                  TEXT NOT NULL,
        description            TEXT,
        severity               TEXT NOT NULL DEFAULT 'MEDIUM',
        priority               TEXT NOT NULL DEFAULT 'MEDIUM',
        status                 TEXT NOT NULL DEFAULT 'REPORTED',
        location_type          TEXT,
        floor_id               UUID REFERENCES floors (id),
        area_id                UUID REFERENCES areas (id),
        room_id                UUID REFERENCES rooms (id),
        space_id               UUID REFERENCES spaces (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        reported_by_user_id    UUID NOT NULL REFERENCES users (id),
        reported_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_at           TIMESTAMPTZ,
        cancelled_by_user_id   UUID REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT incidents_number_unique
          UNIQUE (client_id, incident_number),
        CONSTRAINT incidents_type_check
          CHECK (incident_type IN (
            'OPERATIONAL', 'ASSET_FAILURE', 'FINDING_ESCALATION'
          )),
        CONSTRAINT incidents_severity_check
          CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT incidents_priority_check
          CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT incidents_status_check
          CHECK (status IN ('REPORTED', 'CANCELLED')),
        CONSTRAINT incidents_state_check
          CHECK (
            (status = 'REPORTED'
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
            OR
            (status = 'CANCELLED'
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL)
          ),
        CONSTRAINT incidents_location_type_check
          CHECK (location_type IS NULL OR location_type IN (
            'FLOOR', 'AREA', 'ROOM', 'SPACE', 'FUNCTIONAL_LOCATION'
          )),
        CONSTRAINT incidents_location_reference_check
          CHECK (
            (location_type IS NULL
              AND floor_id IS NULL AND area_id IS NULL AND room_id IS NULL
              AND space_id IS NULL AND functional_location_id IS NULL)
            OR
            (location_type = 'FLOOR'
              AND floor_id IS NOT NULL
              AND area_id IS NULL AND room_id IS NULL
              AND space_id IS NULL AND functional_location_id IS NULL)
            OR
            (location_type = 'AREA'
              AND area_id IS NOT NULL
              AND floor_id IS NULL AND room_id IS NULL
              AND space_id IS NULL AND functional_location_id IS NULL)
            OR
            (location_type = 'ROOM'
              AND room_id IS NOT NULL
              AND floor_id IS NULL AND area_id IS NULL
              AND space_id IS NULL AND functional_location_id IS NULL)
            OR
            (location_type = 'SPACE'
              AND space_id IS NOT NULL
              AND floor_id IS NULL AND area_id IS NULL AND room_id IS NULL
              AND functional_location_id IS NULL)
            OR
            (location_type = 'FUNCTIONAL_LOCATION'
              AND functional_location_id IS NOT NULL
              AND floor_id IS NULL AND area_id IS NULL AND room_id IS NULL
              AND space_id IS NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX incidents_building_idx
        ON incidents (building_id, status, reported_at DESC);
      CREATE INDEX incidents_client_idx
        ON incidents (client_id, status, reported_at DESC);
      CREATE INDEX incidents_type_idx
        ON incidents (incident_type, status, reported_at DESC);
      CREATE INDEX incidents_severity_idx
        ON incidents (severity, status, reported_at DESC);
      CREATE INDEX incidents_priority_idx
        ON incidents (priority, status, reported_at DESC);
      CREATE INDEX incidents_reported_by_idx
        ON incidents (reported_by_user_id, reported_at DESC);
      CREATE INDEX incidents_floor_idx ON incidents (floor_id);
      CREATE INDEX incidents_area_idx ON incidents (area_id);
      CREATE INDEX incidents_room_idx ON incidents (room_id);
      CREATE INDEX incidents_space_idx ON incidents (space_id);
      CREATE INDEX incidents_functional_location_idx
        ON incidents (functional_location_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS incidents');
  },
};
