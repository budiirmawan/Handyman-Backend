import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03H — External / Vendor Workforce affiliation.
 *
 * Links an existing Workforce Profile (BE-03C) to an External Organization
 * (0032):
 *
 *   Workforce Profile → External Workforce Link → External Organization
 *
 * The link IS the external/vendor workforce record: it carries the vendor's
 * own personnel code, an ACTIVE/INACTIVE status, and an optional effective
 * window. A Workforce Profile therefore exists entirely without this table —
 * and, crucially, external workforce must be able to exist without a User
 * account: nothing here touches `users`, `user_credentials`, `roles`,
 * `permissions`, or Building access. Creating an affiliation never creates
 * credentials and never grants Role/Permission/Building access.
 *
 * Duplicate protection follows the BE-03D2/BE-03E/BE-03G idiom — a *partial*
 * unique index over ACTIVE rows — so a profile holds one ACTIVE affiliation
 * per External Organization while deactivated history is preserved. The
 * vendor's personnel code is additionally unique within the External
 * Organization (the BE-03C employee-code rule, applied to the vendor's own
 * numbering).
 *
 * Cross-table rules the FKs cannot express live in the service layer:
 *   - the Workforce Profile must be of type EXTERNAL,
 *   - the Workforce Profile and the External Organization must resolve to the
 *     same Client (profile → organization → client),
 *   - an INACTIVE External Organization receives no affiliations,
 *   - an INACTIVE Workforce Profile receives no ACTIVE affiliation.
 */
export const migration0033CreateExternalWorkforceLinks: Migration = {
  id: '0033_create_external_workforce_links',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE external_workforce_links (
        id                       UUID PRIMARY KEY,
        workforce_profile_id     UUID NOT NULL,
        external_organization_id UUID NOT NULL,
        external_personnel_code  TEXT NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from           TIMESTAMPTZ,
        effective_until          TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT external_workforce_links_workforce_profile_id_fkey
          FOREIGN KEY (workforce_profile_id) REFERENCES workforce_profiles (id),
        CONSTRAINT external_workforce_links_external_organization_id_fkey
          FOREIGN KEY (external_organization_id) REFERENCES external_organizations (id),
        CONSTRAINT external_workforce_links_personnel_code_unique
          UNIQUE (external_organization_id, external_personnel_code),
        CONSTRAINT external_workforce_links_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT external_workforce_links_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // One ACTIVE affiliation per (profile, external organization); INACTIVE
    // history is retained, and a profile may still be affiliated with several
    // different external organizations over time.
    await client.query(`
      CREATE UNIQUE INDEX external_workforce_links_active_unique
        ON external_workforce_links (workforce_profile_id, external_organization_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX external_workforce_links_workforce_profile_id_idx
        ON external_workforce_links (workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX external_workforce_links_external_organization_id_idx
        ON external_workforce_links (external_organization_id)
    `);
    await client.query(`
      CREATE INDEX external_workforce_links_status_idx
        ON external_workforce_links (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS external_workforce_links');
  },
};
