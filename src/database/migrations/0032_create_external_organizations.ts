import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03H — External / Vendor Workforce: minimum External Organization
 * reference.
 *
 * No Vendor domain existed before this Wave, and BE-03H must NOT build a full
 * Vendor module. This table is therefore only the *reference* the external
 * workforce affiliation needs: an external organization (vendor, supplier of
 * labour, outsourced contractor firm, …) that belongs to one Client and can
 * be pointed at by `external_workforce_links` (0033).
 *
 * It is deliberately modelled on the BE-03A `organizations` shape — id,
 * client scope, code, name, status, timestamps — so that when a real Vendor
 * module arrives in a later Wave it can grow from here without a rewrite.
 *
 * `code` is unique per Client. There are no Workflows here: no registration,
 * no approval, no vendor contract lifecycle. Rows are created by later Waves
 * (or seeded directly in tests); BE-03H only reads them.
 */
export const migration0032CreateExternalOrganizations: Migration = {
  id: '0032_create_external_organizations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE external_organizations (
        id           UUID PRIMARY KEY,
        client_id    UUID NOT NULL,
        code         TEXT NOT NULL,
        name         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT external_organizations_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT external_organizations_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT external_organizations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX external_organizations_client_id_idx
        ON external_organizations (client_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS external_organizations');
  },
};
