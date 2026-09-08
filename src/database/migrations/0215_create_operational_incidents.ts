import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21B — Operational Incident specialization.
 *
 * An Operational Incident IS a BE-21A Incident with
 * `incident_type = 'OPERATIONAL'`. This table is the thin specialization
 * attached to exactly one such Incident — it is NOT a second Incident engine
 * and NOT a second identity.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * Incident reference (`incident_number`), Client / Building context, Location,
 * title, description, severity, priority, `reported_by`, and the Incident
 * lifecycle status all remain on BE-21A's `incidents` table and are never
 * copied here. Duplicating them would create a second source of truth for
 * Incident identity and status, which BE-21 forbids. The API composes the two
 * with a JOIN instead.
 *
 * `incident_id` is UNIQUE, so an Incident has at most one Operational
 * specialization, and it is the SHARED identity: the API addresses an
 * Operational Incident by its Incident id. The partial unique index on
 * `incidents` is unnecessary — the FK plus UNIQUE already guarantee 1:1 — but
 * the service additionally refuses to attach this row to an Incident whose
 * `incident_type` is not OPERATIONAL, so ASSET_FAILURE (BE-21C) and
 * FINDING_ESCALATION (BE-21D) can never acquire an Operational body.
 *
 * WHAT IS GENUINELY NEW (the reason this migration exists)
 * -------------------------------------------------------
 *   operational_category  the controlled operational vocabulary
 *   occurred_at           WHEN it happened, distinct from when it was reported
 *   operational_status    operational handling progression, distinct from the
 *                         BE-21A record lifecycle (REPORTED / CANCELLED)
 *   notes                 free operational remarks
 *
 * `operational_status` is NOT a duplicate of `incidents.status`: the
 * foundation status answers "does this Incident record stand or was it
 * withdrawn", while this answers "how far has the operational response got".
 * A CANCELLED Incident freezes this value — enforced in the service, which is
 * the single authority for transitions and available actions.
 *
 * Investigation, corrective action, responsible person, due date,
 * verification, and closure are later BE-21 PARTs and are absent by design.
 */
export const migration0215CreateOperationalIncidents: Migration = {
  id: '0215_create_operational_incidents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE operational_incidents (
        id                   UUID PRIMARY KEY,
        incident_id          UUID NOT NULL UNIQUE REFERENCES incidents (id),
        operational_category TEXT NOT NULL,
        occurred_at          TIMESTAMPTZ NOT NULL,
        operational_status   TEXT NOT NULL DEFAULT 'OPEN',
        status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes                TEXT,
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT operational_incidents_category_check
          CHECK (operational_category IN (
            'UTILITY_FAILURE', 'ELECTRICAL', 'PLUMBING', 'HVAC',
            'LIFT_ESCALATOR', 'FIRE_SAFETY', 'WATER_LEAK', 'STRUCTURAL',
            'ENVIRONMENTAL', 'HOUSEKEEPING', 'SECURITY', 'SAFETY',
            'ACCESS', 'OTHER'
          )),
        CONSTRAINT operational_incidents_status_check
          CHECK (operational_status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED'))
      )
    `);

    await client.query(`
      CREATE INDEX operational_incidents_category_idx
        ON operational_incidents (operational_category, operational_status);
      CREATE INDEX operational_incidents_status_idx
        ON operational_incidents (operational_status, occurred_at DESC);
      CREATE INDEX operational_incidents_occurred_idx
        ON operational_incidents (occurred_at DESC);
      CREATE INDEX operational_incidents_incident_idx
        ON operational_incidents (incident_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS operational_incidents');
  },
};
