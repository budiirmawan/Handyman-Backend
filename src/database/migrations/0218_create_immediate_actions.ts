import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21E — Immediate Action.
 *
 * An Immediate Action is the lightweight containment step taken right away in
 * response to an Incident ("isolated the valve", "cordoned off the area"). It
 * belongs to exactly one BE-21A Incident of ANY type — Operational (BE-21B),
 * Asset Failure (BE-21C), or Finding Escalation (BE-21D) — because containment
 * is common to all of them.
 *
 * HOW THIS DIFFERS FROM BE-21B/C/D
 * --------------------------------
 * Those are 1:1 SPECIALIZATIONS: each adds a body to one Incident and shares
 * its identity, so `incident_id` is UNIQUE there. This is a CHILD COLLECTION:
 * one Incident legitimately has several immediate actions, so `incident_id` is
 * deliberately NOT unique and an Immediate Action has its OWN id. It is
 * addressed by that id, never by the Incident id.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * Client / Building context, Location, severity, priority, and the Incident
 * lifecycle status all remain on `incidents` and are resolved through the FK.
 * Copying them would fork Incident context and let an action disagree with its
 * own Incident about which Building it happened in.
 *
 * This is NOT Investigation (BE-21F) and NOT Corrective Action (BE-21G).
 * The distinction is deliberate and enforced by what is absent: there is no
 * root-cause field, no verification, no closure, no responsible-party
 * assignment workflow, and no due date. `responsible_user_id` records WHO DID
 * the containment, not an assignment to be tracked — BE-21H/BE-21I own
 * responsibility and due dates when they arrive.
 *
 * HISTORY
 * -------
 * "Preserve action history" is satisfied by the shared append-only BE-07
 * `operational_events` log (entity_type = 'IMMEDIATE_ACTION'), which is the
 * established history primitive in this codebase — NOT by a new bespoke
 * history table. In addition, `completed_at` / `completed_by_user_id` /
 * `status_changed_at` are preserved ON the row so a completion is never a
 * destructive overwrite, mirroring how BE-05E preserves asset transitions.
 *
 * The CHECK constraints make the completion invariant structural rather than
 * merely enforced in code: a COMPLETED row MUST carry its completion metadata,
 * and a non-COMPLETED row must not.
 */
export const migration0218CreateImmediateActions: Migration = {
  id: '0218_create_immediate_actions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE immediate_actions (
        id                   UUID PRIMARY KEY,
        incident_id          UUID NOT NULL REFERENCES incidents (id),
        action_type          TEXT NOT NULL,
        description          TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PLANNED',
        taken_at             TIMESTAMPTZ NOT NULL,
        responsible_user_id  UUID REFERENCES users (id),
        completed_at         TIMESTAMPTZ,
        completed_by_user_id UUID REFERENCES users (id),
        completion_notes     TEXT,
        status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes                TEXT,
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT immediate_actions_type_check
          CHECK (action_type IN (
            'CONTAINMENT', 'ISOLATION', 'SHUTDOWN', 'EVACUATION',
            'BARRICADE', 'TEMPORARY_REPAIR', 'CLEANUP', 'NOTIFICATION',
            'FIRST_AID', 'OTHER'
          )),
        CONSTRAINT immediate_actions_status_check
          CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
        CONSTRAINT immediate_actions_completion_check
          CHECK (
            (status = 'COMPLETED'
              AND completed_at IS NOT NULL
              AND completed_by_user_id IS NOT NULL)
            OR
            (status <> 'COMPLETED'
              AND completed_at IS NULL
              AND completed_by_user_id IS NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX immediate_actions_incident_idx
        ON immediate_actions (incident_id, taken_at DESC);
      CREATE INDEX immediate_actions_status_idx
        ON immediate_actions (status, taken_at DESC);
      CREATE INDEX immediate_actions_type_idx
        ON immediate_actions (action_type, status);
      CREATE INDEX immediate_actions_responsible_idx
        ON immediate_actions (responsible_user_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS immediate_actions');
  },
};
