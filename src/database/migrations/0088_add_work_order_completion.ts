import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08H — Work Order Completion foundation.
 *
 * Adds the minimum completion data to `work_orders`. `completed_at` already
 * exists (set when the lifecycle transitions to COMPLETED via BE-08C); this
 * migration adds the actor and summary/notes. Completion means operational
 * work is finished and ready for verification — it is NOT final closure
 * (BE-08I owns Verification / Rework / Closure).
 *
 * A completed Work Order must not receive normal execution actions unless a
 * later rework explicitly reopens it; that rule is enforced in the service
 * layer, not here.
 */
export const migration0088AddWorkOrderCompletion: Migration = {
  id: '0088_add_work_order_completion',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_orders
        ADD COLUMN completed_by_user_id UUID REFERENCES users (id),
        ADD COLUMN completion_summary TEXT,
        ADD COLUMN completion_notes TEXT
    `);

    await client.query(`
      CREATE INDEX work_orders_completed_by_idx
        ON work_orders (completed_by_user_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_orders
        DROP COLUMN completed_by_user_id,
        DROP COLUMN completion_summary,
        DROP COLUMN completion_notes
    `);
  },
};
