import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12H — Security Finding Binding.
 *
 * The minimal Security context record for a BE-09 Finding: which Security
 * source (Patrol Execution / Patrol Checklist / Security Daily Activity /
 * Shift Handover / Security Post) produced it, and which Security Post and
 * Patrol Route it is bound to.
 *
 * The Finding itself lives exclusively in BE-09's `findings` table — its
 * lifecycle, classification/severity, source binding, assignment,
 * verification, rework, closure, and available actions all remain BE-09's.
 * This table holds Security references and context only; `finding_id` is
 * UNIQUE so a Finding has at most one Security context. Duplicate unintended
 * Security Findings from the same source are prevented by a partial UNIQUE
 * index over (source_type, source_id).
 *
 * The `source_type` enum is intentionally separate from BE-09's
 * `findings.source_type`: BE-09's enum knows WORK_ORDER / CHECKLIST_EXECUTION
 * / FORM_INSTANCE; the Security binding knows the Security operational
 * sources (PATROL_EXECUTION / PATROL_CHECKLIST / SECURITY_DAILY_ACTIVITY /
 * SHIFT_HANDOVER / SECURITY_POST). We do NOT alter BE-09's enum.
 *
 * `client_id` / `building_id` are stored directly but derived authoritatively
 * by the service from Building → Property → Client (BE-02), so isolation
 * can never drift.
 */
export const migration0128CreateSecurityFindingLinks: Migration = {
  id: '0128_create_security_finding_links',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_finding_links (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        finding_id             UUID NOT NULL UNIQUE REFERENCES findings (id),
        start_security_post_id UUID REFERENCES security_posts (id),
        patrol_route_id        UUID REFERENCES patrol_routes (id),
        source_type            TEXT NOT NULL,
        source_id              UUID NOT NULL,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_finding_source_type_check
          CHECK (source_type IN (
            'PATROL_EXECUTION',
            'PATROL_CHECKLIST',
            'SECURITY_DAILY_ACTIVITY',
            'SHIFT_HANDOVER',
            'SECURITY_POST'
          ))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX security_finding_source_unique
        ON security_finding_links (source_type, source_id);
      CREATE INDEX security_finding_links_building_idx
        ON security_finding_links (building_id);
      CREATE INDEX security_finding_links_finding_idx
        ON security_finding_links (finding_id);
      CREATE INDEX security_finding_links_start_post_idx
        ON security_finding_links (start_security_post_id);
      CREATE INDEX security_finding_links_patrol_route_idx
        ON security_finding_links (patrol_route_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS security_finding_links');
  },
};
