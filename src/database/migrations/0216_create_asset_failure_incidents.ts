import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21C — Asset Failure / Defect specialization.
 *
 * An Asset Failure / Defect IS a BE-21A Incident with
 * `incident_type = 'ASSET_FAILURE'`. This table is the thin specialization
 * attached to exactly one such Incident — it is NOT a second Incident engine,
 * NOT a second identity, and NOT an Asset registry.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * Incident reference (`incident_number`), Client / Building context, Location,
 * title, defect description, severity, priority, `reported_by`, and the
 * Incident lifecycle status all remain on BE-21A's `incidents` table. Asset
 * master data (code, name, manufacturer, model, serial number, asset status,
 * functional location) remains on BE-05's `assets` table. NEITHER is copied
 * here: duplicating Incident fields would fork Incident identity, and
 * duplicating Asset fields would fork the Asset registry. The API composes all
 * three with a JOIN instead.
 *
 * THE TYPED ASSET BINDING
 * -----------------------
 * `asset_id` is a real, typed foreign key to `assets (id)` — not a polymorphic
 * `entity_type` + `entity_id` pair. The database therefore guarantees the
 * referenced Asset exists, and an Asset can never be silently deleted out from
 * under a recorded failure.
 *
 * It lives HERE rather than on `incidents` because an Asset reference is
 * meaningful ONLY for ASSET_FAILURE. Adding `asset_id` to the shared
 * foundation would put type-specific data on the shared table, leaving a
 * column that is permanently NULL for OPERATIONAL (BE-21B) and
 * FINDING_ESCALATION (BE-21D) — exactly the shared-table pollution the BE-21A
 * governance decision exists to prevent. `NOT NULL` here is strictly stronger
 * than a nullable foundation column: an Asset Failure without an Asset is
 * impossible by construction.
 *
 * `incident_id` is UNIQUE, so an Incident has at most one Asset Failure body,
 * and it is the SHARED identity: the API addresses an Asset Failure by its
 * Incident id. `asset_id` is deliberately NOT unique — one Asset legitimately
 * accumulates many failures over its life.
 *
 * WHAT IS GENUINELY NEW (the reason this migration exists)
 * -------------------------------------------------------
 *   asset_id            the typed BE-05 Asset / Equipment binding
 *   failure_category    the controlled failure / defect vocabulary
 *   occurred_at         WHEN it failed, distinct from when it was reported
 *   operational_impact  the effect on service ("where applicable" → nullable)
 *   failure_status      failure-handling progression, distinct from the BE-21A
 *                       record lifecycle (REPORTED / CANCELLED) and from the
 *                       BE-05E Asset lifecycle (ACTIVE / UNDER_MAINTENANCE...)
 *   notes               free technical remarks
 *
 * `failure_status` is NOT a duplicate of `incidents.status` nor of
 * `assets.status`. The foundation status answers "does this Incident record
 * stand or was it withdrawn"; the Asset status answers "is this equipment in
 * service"; this answers "how far has the failure response got". Recording a
 * failure deliberately does NOT drive the Asset through its own BE-05E
 * lifecycle — that remains an explicit, separately-authorized action.
 *
 * Immediate action, investigation, corrective action, responsible person, due
 * date, verification, and closure are later BE-21 PARTs, absent by design.
 * Finding Escalation (BE-21D) is likewise not implemented here.
 */
export const migration0216CreateAssetFailureIncidents: Migration = {
  id: '0216_create_asset_failure_incidents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_failure_incidents (
        id                  UUID PRIMARY KEY,
        incident_id         UUID NOT NULL UNIQUE REFERENCES incidents (id),
        asset_id            UUID NOT NULL REFERENCES assets (id),
        failure_category    TEXT NOT NULL,
        occurred_at         TIMESTAMPTZ NOT NULL,
        operational_impact  TEXT,
        failure_status      TEXT NOT NULL DEFAULT 'OPEN',
        status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes               TEXT,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_failure_incidents_category_check
          CHECK (failure_category IN (
            'MECHANICAL_FAILURE', 'ELECTRICAL_FAILURE', 'CONTROL_FAILURE',
            'STRUCTURAL_DEFECT', 'LEAKAGE', 'OVERHEATING', 'VIBRATION_NOISE',
            'CORROSION', 'WEAR_AND_TEAR', 'CALIBRATION_DRIFT',
            'SOFTWARE_FAULT', 'INSTALLATION_DEFECT', 'MANUFACTURING_DEFECT',
            'OTHER'
          )),
        CONSTRAINT asset_failure_incidents_impact_check
          CHECK (operational_impact IS NULL OR operational_impact IN (
            'NONE', 'DEGRADED', 'PARTIAL_OUTAGE', 'FULL_OUTAGE', 'SAFETY_RISK'
          )),
        CONSTRAINT asset_failure_incidents_status_check
          CHECK (failure_status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED'))
      )
    `);

    await client.query(`
      CREATE INDEX asset_failure_incidents_asset_idx
        ON asset_failure_incidents (asset_id, occurred_at DESC);
      CREATE INDEX asset_failure_incidents_category_idx
        ON asset_failure_incidents (failure_category, failure_status);
      CREATE INDEX asset_failure_incidents_status_idx
        ON asset_failure_incidents (failure_status, occurred_at DESC);
      CREATE INDEX asset_failure_incidents_occurred_idx
        ON asset_failure_incidents (occurred_at DESC);
      CREATE INDEX asset_failure_incidents_incident_idx
        ON asset_failure_incidents (incident_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_failure_incidents');
  },
};
