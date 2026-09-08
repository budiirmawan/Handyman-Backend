import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02C — Module Entitlement foundation.
 *
 * The commercial relationship between a Subscription and a Module. Belongs to
 * exactly one Subscription (Subscription → Entitlement → Module). No
 * client_id is stored here — ownership resolves authoritatively through the
 * Subscription (avoiding competing sources of truth).
 *
 * Status lifecycle: ACTIVE / SUSPENDED / EXPIRED / REVOKED. At most one ACTIVE
 * entitlement may exist for a given Subscription + Module pair.
 */
export const migration0016CreateModuleEntitlements: Migration = {
  id: '0016_create_module_entitlements',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE module_entitlements (
        id UUID PRIMARY KEY,
        subscription_id UUID NOT NULL,
        module_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT module_entitlements_subscription_id_fkey
          FOREIGN KEY (subscription_id) REFERENCES subscriptions (id),
        CONSTRAINT module_entitlements_module_id_fkey
          FOREIGN KEY (module_id) REFERENCES modules (id),
        CONSTRAINT module_entitlements_status_check
          CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
        CONSTRAINT module_entitlements_period_check
          CHECK (ends_at IS NULL OR ends_at > starts_at)
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX module_entitlements_one_active_per_sub_module
       ON module_entitlements (subscription_id, module_id) WHERE status = 'ACTIVE'`,
    );
    await client.query(
      `CREATE INDEX module_entitlements_subscription_id_idx
       ON module_entitlements (subscription_id)`,
    );
    await client.query(
      `CREATE INDEX module_entitlements_module_id_idx
       ON module_entitlements (module_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS module_entitlements');
  },
};
