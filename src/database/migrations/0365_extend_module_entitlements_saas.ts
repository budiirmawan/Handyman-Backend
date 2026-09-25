import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 04 — SaaS entitlement source & limit extension.
 *
 * Frozen contract §12.1 / §5 seam map: the existing `module_entitlements`
 * authority (0016) is EXTENDED, never replaced — no parallel entitlement
 * table is created. Two additive columns:
 *
 *   - `source`      — provenance of the grant. Frozen vocabulary
 *                     PACKAGE / ADD_ON / OVERRIDE / PROMOTION / MANUAL.
 *                     The CHECK carries the full frozen vocabulary so the
 *                     schema is future-compatible with later PARTs; PART 04
 *                     only ever WRITES `PACKAGE` (deterministic package
 *                     materialization) and `OVERRIDE` (console command,
 *                     audited). All pre-existing rows are `MANUAL` via the
 *                     NOT NULL DEFAULT — no row is rewritten.
 *   - `limit_value` — nullable BIGINT; explicit limit on the grant
 *                     (frozen §12.1: 0 = unlimited; NULL = not explicitly
 *                     set, i.e. the resolution chain falls through to the
 *                     package limit definitions).
 *
 * The one-active-per-(subscription, module) partial unique index (0016) is
 * preserved unchanged: at most one ACTIVE entitlement per pair, whatever its
 * source. No destructive rewrite, no legacy row conversion.
 */
export const migration0365ExtendModuleEntitlementsSaas: Migration = {
  id: '0365_extend_module_entitlements_saas',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE module_entitlements
        ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL',
        ADD COLUMN limit_value BIGINT,
        ADD CONSTRAINT module_entitlements_source_check
          CHECK (source IN ('PACKAGE', 'ADD_ON', 'OVERRIDE', 'PROMOTION', 'MANUAL')),
        ADD CONSTRAINT module_entitlements_limit_value_check
          CHECK (limit_value IS NULL OR limit_value >= 0)
    `);
    // Deterministic package reconciliation lookup (PART 04 sync):
    // stale PACKAGE-derived rows are found per subscription.
    await client.query(`
      CREATE INDEX module_entitlements_subscription_package_idx
        ON module_entitlements (subscription_id)
      WHERE source = 'PACKAGE'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS module_entitlements_subscription_package_idx',
    );
    await client.query(`
      ALTER TABLE module_entitlements
        DROP CONSTRAINT IF EXISTS module_entitlements_limit_value_check,
        DROP CONSTRAINT IF EXISTS module_entitlements_source_check,
        DROP COLUMN IF EXISTS limit_value,
        DROP COLUMN IF EXISTS source
    `);
  },
};
