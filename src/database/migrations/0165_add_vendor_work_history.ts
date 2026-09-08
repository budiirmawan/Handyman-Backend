import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15K — Vendor Work History binding.
 *
 * Reuses the shared BE-07 operational-events audit foundation rather than
 * creating a second audit engine. This migration only adds an optional
 * `vendor_work_id` link to `operational_events` so every BE-15 domain event
 * (assignment, work lifecycle, checklist, permit readiness, evidence,
 * completion/service report, BAST, verification, rework) can be queried as a
 * single, append-oriented, chronologically ordered Vendor Work history.
 *
 * The column is deliberately nullable: events produced by other domains
 * (BE-08 Work Order, BE-10 Engineering, …) carry NULL and remain untouched.
 */
export const migration0165AddVendorWorkHistory: Migration = {
  id: '0165_add_vendor_work_history',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_events
        ADD COLUMN vendor_work_id UUID REFERENCES vendor_works (id)
    `);

    await client.query(`
      CREATE INDEX operational_events_vendor_work_idx
        ON operational_events (vendor_work_id, occurred_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS operational_events_vendor_work_idx;
      ALTER TABLE operational_events
        DROP COLUMN IF EXISTS vendor_work_id
    `);
  },
};
