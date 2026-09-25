import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 01 — platform-scope canonical audit (frozen decision D1).
 *
 * `operational_events` remains the SINGLE canonical audit store. The SaaS
 * Control Plane needs to record platform-scope events (product catalog,
 * pricebook, platform configuration, support sessions) that have no customer;
 * customer-scoped events are unchanged.
 *
 * This migration only relaxes the `client_id` nullability — a constraint
 * drop, not a data rewrite. Every existing row keeps its `client_id`, and
 * customer-scoped event recording is byte-for-byte unchanged. The
 * `recordOperationalEvent` seam skips integration-outbox fan-out for
 * NULL-client events (the outbox is customer-scoped by design).
 */
export const migration0361AllowPlatformScopeOperationalEvents: Migration = {
  id: '0361_allow_platform_scope_operational_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_events
        ALTER COLUMN client_id DROP NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Restores the pre-CR constraint. Fails (as expected) when platform-scope
    // rows already exist — down migrations are not used casually (README).
    await client.query(`
      ALTER TABLE operational_events
        ALTER COLUMN client_id SET NOT NULL
    `);
  },
};
