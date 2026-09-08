import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02D — Property foundation.
 *
 * A Property is the commercial/property grouping owned by a Client (Client →
 * Property). It may represent an estate, office property, mixed-use property,
 * building complex, or campus grouping. It is NOT a Building, Floor, Area,
 * Room, Organization, or Tenant.
 *
 * `code` is the stable machine-readable identifier, normalized to uppercase by
 * the service layer. Uniqueness is scoped to Client (`client_id + code`) to
 * support multi-client operation. Inactive Properties are preserved for
 * history — never hard-deleted through normal lifecycle handling.
 */
export const migration0017CreateProperties: Migration = {
  id: '0017_create_properties',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE properties (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        address_line TEXT,
        city TEXT,
        province TEXT,
        postal_code TEXT,
        country_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT properties_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT properties_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT properties_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(
      `CREATE INDEX properties_client_id_idx ON properties (client_id)`,
    );
    await client.query(
      `CREATE INDEX properties_status_idx ON properties (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS properties');
  },
};
