import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21D — Finding Escalation specialization.
 *
 * A Finding Escalation IS a BE-21A Incident with
 * `incident_type = 'FINDING_ESCALATION'` that points at an existing BE-09
 * Finding. It is NOT a second Incident engine, NOT a second identity, and
 * emphatically NOT a second Finding engine.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * Incident reference (`incident_number`), Client / Building context, title,
 * description, severity, priority, `reported_by`, and the Incident lifecycle
 * status all remain on BE-21A's `incidents` table. Finding state, workflow,
 * assignment, and history all remain in BE-09 (`findings` +
 * `operational_events`). NEITHER is copied here.
 *
 * In particular there is NO `finding_status` column. Finding state is
 * projected live through the JOIN, so an escalation can never disagree with
 * BE-09 about the Finding's state, and escalating never forks the Finding
 * workflow. There is likewise no escalation-specific status column: inventing
 * a third lifecycle (alongside the Incident's and the Finding's) would be
 * exactly the duplication BE-21D forbids.
 *
 * `incident_id` is UNIQUE, so an Incident has at most one escalation body, and
 * it is the SHARED identity: the API addresses an escalation by its Incident
 * id. `finding_id` is deliberately NOT globally unique — a Finding that was
 * escalated and then had its escalation CANCELLED may legitimately be
 * escalated again. "At most one ACTIVE escalation per Finding" spans this
 * table and `incidents.status`, so it cannot be expressed as a partial unique
 * index here; the service enforces it by taking a row lock on the Finding for
 * the duration of the create, which serializes concurrent escalations of the
 * same Finding rather than merely check-then-acting.
 *
 * WHAT IS GENUINELY NEW (the reason this migration exists)
 * -------------------------------------------------------
 *   finding_id         the typed BE-09 Finding binding
 *   escalation_reason  the controlled reason this Finding was escalated
 *   escalated_at       when the escalation was raised
 *   notes              free escalation remarks
 *
 * Immediate action (BE-21E), investigation, corrective action, responsible
 * person, due date, verification, and closure are later BE-21 PARTs and are
 * absent by design.
 */
export const migration0217CreateFindingEscalationIncidents: Migration = {
  id: '0217_create_finding_escalation_incidents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE finding_escalation_incidents (
        id                 UUID PRIMARY KEY,
        incident_id        UUID NOT NULL UNIQUE REFERENCES incidents (id),
        finding_id         UUID NOT NULL REFERENCES findings (id),
        escalation_reason  TEXT NOT NULL,
        escalated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes              TEXT,
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finding_escalation_incidents_reason_check
          CHECK (escalation_reason IN (
            'SLA_BREACH', 'REPEAT_FINDING', 'SAFETY_RISK', 'HIGH_SEVERITY',
            'UNRESOLVED', 'REGULATORY', 'RESOURCE_CONSTRAINT', 'OTHER'
          ))
      )
    `);

    await client.query(`
      CREATE INDEX finding_escalation_incidents_finding_idx
        ON finding_escalation_incidents (finding_id, escalated_at DESC);
      CREATE INDEX finding_escalation_incidents_reason_idx
        ON finding_escalation_incidents (escalation_reason);
      CREATE INDEX finding_escalation_incidents_escalated_idx
        ON finding_escalation_incidents (escalated_at DESC);
      CREATE INDEX finding_escalation_incidents_incident_idx
        ON finding_escalation_incidents (incident_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS finding_escalation_incidents');
  },
};
