import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 03 — extend the existing `subscriptions` foundation
 * into the canonical SaaS Subscription aggregate (frozen contract §11.1).
 *
 * The existing table (0013) is the SOLE subscription authority (frozen
 * identity model §6: `SaasCustomer → 1..n Subscription (subscriptions,
 * extended)`). This migration is ADDITIVE and non-destructive:
 *
 *   - new columns are NULL-able (legacy rows keep working unchanged);
 *   - `version INTEGER NOT NULL DEFAULT 1` backfills every existing row
 *     with version 1 (no row rewrite beyond the default fill);
 *   - the status CHECK is widened to the canonical §11.2 vocabulary while
 *     PRESERVING the legacy values (D6: legacy `PENDING`/`EXPIRED` remain
 *     readable, never newly written);
 *   - `plan_code` stays NOT NULL and informational — new SaaS writes fill
 *     it as a display alias of the package code (server-filled, never a
 *     driver);
 *   - `code` stays the stable unique business identifier (server-generated
 *     for control-plane rows);
 *   - historical commercial integrity: new SaaS subscriptions reference
 *     the immutable/versioned `saas_pricebook_versions.id` (0363) — later
 *     pricebook publication/supersession never restates these references.
 *
 * No destructive rewrite; all existing subscription ids, codes and legacy
 * statuses remain valid.
 */
export const migration0364ExtendSubscriptionsSaas: Migration = {
  id: '0364_extend_subscriptions_saas',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE subscriptions
        ADD COLUMN product_id UUID
          REFERENCES saas_products (id),
        ADD COLUMN package_id UUID
          REFERENCES saas_packages (id),
        ADD COLUMN pricebook_version_id UUID
          REFERENCES saas_pricebook_versions (id),
        ADD COLUMN billing_cycle TEXT
          CHECK (billing_cycle IS NULL OR billing_cycle IN ('MONTHLY', 'ANNUAL', 'CUSTOM')),
        ADD COLUMN currency_code VARCHAR(3)
          REFERENCES currencies (code),
        ADD COLUMN trial_end_date TIMESTAMPTZ,
        ADD COLUMN current_period_start TIMESTAMPTZ,
        ADD COLUMN current_period_end TIMESTAMPTZ,
        ADD COLUMN renewal_date TIMESTAMPTZ,
        ADD COLUMN grace_until TIMESTAMPTZ,
        ADD COLUMN cancelled_at TIMESTAMPTZ,
        ADD COLUMN terminated_at TIMESTAMPTZ,
        ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    `);

    // Widen the status CHECK to the canonical §11.2 vocabulary while
    // preserving the legacy values (frozen decision D6).
    await client.query(`
      ALTER TABLE subscriptions
        DROP CONSTRAINT subscriptions_status_check
    `);
    await client.query(`
      ALTER TABLE subscriptions
        ADD CONSTRAINT subscriptions_status_check
        CHECK (status IN (
          'PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED',
          'DRAFT', 'TRIAL', 'GRACE', 'PAST_DUE', 'TERMINATED'
        ))
    `);

    await client.query(
      `CREATE INDEX subscriptions_product_id_idx
         ON subscriptions (product_id)`,
    );
    await client.query(
      `CREATE INDEX subscriptions_package_id_idx
         ON subscriptions (package_id)`,
    );
    await client.query(
      `CREATE INDEX subscriptions_pricebook_version_id_idx
         ON subscriptions (pricebook_version_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE subscriptions
        DROP COLUMN product_id,
        DROP COLUMN package_id,
        DROP COLUMN pricebook_version_id,
        DROP COLUMN billing_cycle,
        DROP COLUMN currency_code,
        DROP COLUMN trial_end_date,
        DROP COLUMN current_period_start,
        DROP COLUMN current_period_end,
        DROP COLUMN renewal_date,
        DROP COLUMN grace_until,
        DROP COLUMN cancelled_at,
        DROP COLUMN terminated_at,
        DROP COLUMN version
    `);
    await client.query(`
      ALTER TABLE subscriptions
        DROP CONSTRAINT subscriptions_status_check
    `);
    await client.query(`
      ALTER TABLE subscriptions
        ADD CONSTRAINT subscriptions_status_check
        CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'))
    `);
    await client.query('DROP INDEX IF EXISTS subscriptions_product_id_idx');
    await client.query('DROP INDEX IF EXISTS subscriptions_package_id_idx');
    await client.query(
      'DROP INDEX IF EXISTS subscriptions_pricebook_version_id_idx',
    );
  },
};
