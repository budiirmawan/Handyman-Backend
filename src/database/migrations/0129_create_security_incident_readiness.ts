import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12I — Security Incident Readiness.
 *
 * Lightweight, configuration-only readiness records that map a Building
 * (or Building × Security Post) to an incident category, a readiness
 * status (READY / PARTIAL / NOT_READY), a responsible Team / Workforce
 * reference, escalation contact info, reporting instructions, and an
 * optional evidence requirement reference. This is NOT an Incident
 * master record and NOT a workflow / SLA / dispatch / notification
 * engine — it is the configuration that tells the Security operation
 * whether a Post / Building is operationally prepared to report a
 * particular category of incident when one occurs.
 *
 * `client_id` / `building_id` are denormalized for fast listing, but
 * the service derives them authoritatively from Building → Property →
 * Client (BE-02), so isolation can never drift.
 *
 * The optional `security_post_id` makes the readiness Building-level
 * (NULL) or Post-level (set). Multiple readiness records per Building
 * are allowed because each one is scoped to a category.
 *
 * The optional `responsible_team_id` and `responsible_workforce_id`
 * follow BE-03 conventions: a Team belongs to a Department → a Client;
 * a Workforce Profile belongs to an Organization → a Client. Either
 * (or neither) may be set; if both are set they must agree on Client.
 *
 * `evidence_requirement_id` (optional) lets a Building pin a BE-07
 * evidence rule that incoming incident reports should attach. NULL
 * means "no specific evidence rule required at this layer" — the
 * caller may still apply the default BE-07 requirement.
 *
 * No Incident records, no lifecycle, no workflow, no SLA, no
 * notification / dispatch logic.
 */
export const migration0129CreateSecurityIncidentReadiness: Migration = {
  id: '0129_create_security_incident_readiness',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_incident_readiness (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        security_post_id            UUID REFERENCES security_posts (id),
        category                    TEXT NOT NULL,
        readiness_status            TEXT NOT NULL DEFAULT 'NOT_READY',
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        responsible_team_id         UUID REFERENCES teams (id),
        responsible_workforce_id    UUID REFERENCES workforce_profiles (id),
        escalation_contact          TEXT,
        reporting_instructions      TEXT,
        evidence_requirement_id     UUID REFERENCES evidence_requirements (id),
        notes                       TEXT,
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_incident_readiness_category_check
          CHECK (category IN (
            'SECURITY', 'SAFETY', 'FIRE', 'MEDICAL', 'ACCESS',
            'PROPERTY', 'OTHER'
          )),
        CONSTRAINT security_incident_readiness_status_check
          CHECK (readiness_status IN ('READY', 'PARTIAL', 'NOT_READY')),
        CONSTRAINT security_incident_readiness_active_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX security_incident_readiness_active_post_category
        ON security_incident_readiness (building_id, security_post_id, category)
        WHERE status = 'ACTIVE';
      CREATE INDEX security_incident_readiness_building_idx
        ON security_incident_readiness (building_id, status);
      CREATE INDEX security_incident_readiness_post_idx
        ON security_incident_readiness (security_post_id);
      CREATE INDEX security_incident_readiness_category_idx
        ON security_incident_readiness (category, readiness_status);
      CREATE INDEX security_incident_readiness_team_idx
        ON security_incident_readiness (responsible_team_id);
      CREATE INDEX security_incident_readiness_workforce_idx
        ON security_incident_readiness (responsible_workforce_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS security_incident_readiness',
    );
  },
};
