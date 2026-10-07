import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02B — License foundation.
 *
 * A License is the operational validity associated with a Client Subscription
 * (Subscription → License). Kept deliberately lightweight: no cryptographic
 * license-key system. A license belongs to exactly one Subscription and is
 * never valid on its own — the Subscription must itself be commercially valid.
 *
 * Status lifecycle: ACTIVE / SUSPENDED / EXPIRED / REVOKED. At most one ACTIVE
 * license may exist for a given Subscription (partial unique index).
 */
export const migration0014CreateLicenses: Migration = {
  id: '0014_create_licenses',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE licenses (
        id UUID PRIMARY KEY,
        subscription_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        valid_from TIMESTAMPTZ NOT NULL,
        valid_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT licenses_subscription_id_fkey
          FOREIGN KEY (subscription_id) REFERENCES subscriptions (id),
        CONSTRAINT licenses_status_check
          CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
        CONSTRAINT licenses_period_check
          CHECK (valid_until IS NULL OR valid_until > valid_from)
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX licenses_one_active_per_subscription
       ON licenses (subscription_id) WHERE status = 'ACTIVE'`,
    );
    await client.query(
      `CREATE INDEX licenses_subscription_id_idx ON licenses (subscription_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS licenses');
  },
};
