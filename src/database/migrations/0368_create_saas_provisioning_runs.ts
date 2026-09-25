import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 05 — SaaS Provisioning (frozen §13).
 *
 * One run row per idempotency claim. The customer's "provisioning
 * COMPLETED" state is DERIVED from `saas_provisioning_runs` (latest
 * COMPLETED for the customer); no changes to `clients` are required —
 * the provisioning state is the run, the customer reference is on it.
 *
 * The run's `steps` is JSONB (frozen §13.2): per-step
 * `{name, status, naturalKey, resourceIds, error?}`. Each step is
 * anchored on a stable natural key so a retry-after-partial-failure
 * converges on the same resources and never duplicates canonical
 * structures.
 *
 * No new SaaS "tenants" table (frozen D4). The operational authority
 * (`organizations` → `properties` → `buildings` → `users` /
 * `user_building_assignments`) is reused unchanged.
 *
 * PART 08 (Grace, suspension) and PART 09 (Usage) rely on the
 * COMPLETED state for downstream decisions; this schema is the
 * contract their reads key on.
 */
export const migration0368CreateSaasProvisioningRuns: Migration = {
  id: '0368_create_saas_provisioning_runs',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE saas_provisioning_runs (
        id UUID PRIMARY KEY,
        customer_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        attempt INTEGER NOT NULL DEFAULT 1,
        steps JSONB NOT NULL DEFAULT '[]',
        last_error TEXT,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_provisioning_runs_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES clients (id),
        CONSTRAINT saas_provisioning_runs_status_check
          CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        CONSTRAINT saas_provisioning_runs_attempt_check
          CHECK (attempt >= 1)
      )
    `);
    await client.query(
      `CREATE INDEX saas_provisioning_runs_customer_id_idx
        ON saas_provisioning_runs (customer_id)`,
    );
    await client.query(
      `CREATE INDEX saas_provisioning_runs_status_idx
        ON saas_provisioning_runs (status)`,
    );
    await client.query(
      `CREATE INDEX saas_provisioning_runs_created_at_idx
        ON saas_provisioning_runs (created_at DESC)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS saas_provisioning_runs');
  },
};
