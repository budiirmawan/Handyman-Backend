import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN17-SECURITY-INCIDENT-FIELD-01 — Security Incident Reporting Context.
 *
 * Adds canonical reporting-time field context ONLY to the operational
 * specialization (operational_incidents), not to the generic incident
 * foundation:
 *
 *   reported_shift_assignment_id  →  workforce_shift_assignments.id (nullable)
 *   reported_security_post_id     →  security_posts.id (nullable)
 *
 * Both are NULLABLE, default NULL. Existing rows stay NULL — no backfill,
 * no synthetic assignment, no row rewrite. Not every security incident is
 * reported from a fixed post, and historical operational incidents predate
 * this field.
 *
 * Referential integrity only: non-null values must reference existing rows.
 * NO ON DELETE/UPDATE cascade (NO ACTION) — deleting a shift assignment or
 * security post that is still referenced is rejected rather than cascading.
 *
 * Same-building integrity (security post must belong to same building as the
 * shift assignment's shift) cannot be expressed here without broadening the
 * schema (operational_incidents has no building_id column; the post's
 * building is via security_posts.building_id and shift's building via
 * shifts.building_id). It is enforced in the service layer, matching the
 * 0337 convention.
 *
 * Indexes support reverse lookups: "which security incidents were reported
 * from this assignment/post".
 */
export const migration0355AddSecurityIncidentReportingContext: Migration = {
  id: '0355_add_security_incident_reporting_context',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_incidents
        ADD COLUMN reported_shift_assignment_id UUID,
        ADD COLUMN reported_security_post_id UUID,
        ADD CONSTRAINT operational_incidents_reported_shift_assignment_id_fkey
          FOREIGN KEY (reported_shift_assignment_id) REFERENCES workforce_shift_assignments (id),
        ADD CONSTRAINT operational_incidents_reported_security_post_id_fkey
          FOREIGN KEY (reported_security_post_id) REFERENCES security_posts (id)
    `);

    await client.query(`
      CREATE INDEX operational_incidents_reported_shift_assignment_idx
        ON operational_incidents (reported_shift_assignment_id)
    `);

    await client.query(`
      CREATE INDEX operational_incidents_reported_security_post_idx
        ON operational_incidents (reported_security_post_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS operational_incidents_reported_security_post_idx`);
    await client.query(`DROP INDEX IF EXISTS operational_incidents_reported_shift_assignment_idx`);
    await client.query(`
      ALTER TABLE operational_incidents
        DROP CONSTRAINT IF EXISTS operational_incidents_reported_security_post_id_fkey,
        DROP CONSTRAINT IF EXISTS operational_incidents_reported_shift_assignment_id_fkey,
        DROP COLUMN IF EXISTS reported_security_post_id,
        DROP COLUMN IF EXISTS reported_shift_assignment_id
    `);
  },
};
