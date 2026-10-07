import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer registry (extension of `clients`).
 *
 * The existing `clients` row is the canonical SaaS Customer (frozen contract
 * §2/§7). This migration is strictly additive:
 *
 *   - adds the console/commercial registry fields (display name, billing
 *     contact, address, country, currency, timezone);
 *   - extends the `status` lifecycle with the frozen SaaS states
 *     (PROSPECT / TRIAL / GRACE / SUSPENDED / TERMINATED) while KEEPING the
 *     legacy ACTIVE / INACTIVE values — no historical row is rewritten;
 *   - adds `version` for the optimistic-concurrency pattern frozen in
 *     contract §17.3 (the §22 API table requires `expectedVersion` on
 *     PATCH /platform/customers/:id);
 *   - references the global currency authority (0331) for `currency_code`;
 *   - keeps `billing_email` unique where present (partial unique index).
 *
 * Existing client ids, relationships, and business-plane behavior are
 * untouched.
 */
export const migration0360ExtendClientsSaasCustomer: Migration = {
  id: '0360_extend_clients_saas_customer',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE clients
        ADD COLUMN display_name TEXT,
        ADD COLUMN billing_email TEXT,
        ADD COLUMN billing_phone TEXT,
        ADD COLUMN address TEXT,
        ADD COLUMN country VARCHAR(2),
        ADD COLUMN currency_code VARCHAR(3),
        ADD COLUMN timezone TEXT,
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    `);

    // Superset of the legacy lifecycle — legacy values stay valid.
    await client.query(`
      ALTER TABLE clients
        DROP CONSTRAINT clients_status_check,
        ADD CONSTRAINT clients_status_check
          CHECK (status IN (
            'ACTIVE', 'INACTIVE',
            'PROSPECT', 'TRIAL', 'GRACE', 'SUSPENDED', 'TERMINATED'
          ))
    `);

    await client.query(`
      ALTER TABLE clients
        ADD CONSTRAINT clients_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code)
    `);

    await client.query(`
      CREATE UNIQUE INDEX clients_billing_email_unique
        ON clients (billing_email)
        WHERE billing_email IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX clients_status_idx ON clients (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE clients
        DROP CONSTRAINT clients_currency_code_fkey,
        DROP CONSTRAINT clients_status_check,
        ADD CONSTRAINT clients_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
    `);
    await client.query(`
      DROP INDEX IF EXISTS clients_billing_email_unique
    `);
    await client.query(`
      DROP INDEX IF EXISTS clients_status_idx
    `);
    await client.query(`
      ALTER TABLE clients
        DROP COLUMN display_name,
        DROP COLUMN billing_email,
        DROP COLUMN billing_phone,
        DROP COLUMN address,
        DROP COLUMN country,
        DROP COLUMN currency_code,
        DROP COLUMN timezone,
        DROP COLUMN version
    `);
  },
};
