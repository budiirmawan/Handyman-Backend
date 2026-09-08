import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02A — Company & Client foundation.
 *
 * A Client is the top-level customer/commercial boundary: the company or
 * customer operating/subscribing to Asentra. It is deliberately kept distinct
 * from Tenant, Vendor, Department, and internal Organization.
 *
 * `code` is the stable, machine-readable identifier (normalized to uppercase
 * by the service layer) and must be unique. No subscription, license, or
 * entitlement state lives here — those arrive in BE-02B/C.
 */
export const migration0012CreateClients: Migration = {
  id: '0012_create_clients',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE clients (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        legal_name TEXT,
        tax_id TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT clients_code_unique UNIQUE (code),
        CONSTRAINT clients_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS clients');
  },
};
