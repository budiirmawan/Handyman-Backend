import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08C — Work Order priority + lifecycle.
 *
 * Adds `priority` (LOW/MEDIUM/HIGH/CRITICAL) and the full lifecycle status
 * set (OPEN/ASSIGNED/IN_PROGRESS/ON_HOLD/COMPLETED/CANCELLED/CLOSED) plus the
 * lifecycle timestamps justified by those states:
 *   - assigned_at   when the order enters ASSIGNED (first time)
 *   - started_at    when work first starts (IN_PROGRESS, preserved on
 *                    ON_HOLD → IN_PROGRESS re-entry)
 *   - completed_at  when the order is marked COMPLETED
 *   - closed_at     when the order is CLOSED
 *   - cancelled_at  when the order is CANCELLED
 *
 * Only the BE-08B single status `OPEN` existed; the old CHECK constraint is
 * replaced. Verification / rework / closure workflow logic is NOT introduced
 * here — it belongs to BE-08I. Priority is metadata and defaults to MEDIUM.
 */
export const migration0083AddWorkOrderPriorityLifecycle: Migration = {
  id: '0083_add_work_order_priority_lifecycle',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_orders
        ADD COLUMN priority TEXT NOT NULL DEFAULT 'MEDIUM',
        ADD CONSTRAINT work_order_priority
          CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        ADD COLUMN assigned_at TIMESTAMPTZ,
        ADD COLUMN started_at TIMESTAMPTZ,
        ADD COLUMN completed_at TIMESTAMPTZ,
        ADD COLUMN closed_at TIMESTAMPTZ,
        ADD COLUMN cancelled_at TIMESTAMPTZ,
        DROP CONSTRAINT work_order_status
    `);

    await client.query(`
      ALTER TABLE work_orders
        ADD CONSTRAINT work_order_status
          CHECK (status IN
            ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED',
             'CANCELLED', 'CLOSED'))
    `);

    await client.query(`
      CREATE INDEX work_orders_priority_idx
        ON work_orders (priority, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_orders
        DROP CONSTRAINT work_order_priority,
        DROP COLUMN priority,
        DROP COLUMN assigned_at,
        DROP COLUMN started_at,
        DROP COLUMN completed_at,
        DROP COLUMN closed_at,
        DROP COLUMN cancelled_at,
        DROP CONSTRAINT work_order_status
    `);

    await client.query(`
      ALTER TABLE work_orders
        ADD CONSTRAINT work_order_status
          CHECK (status IN ('OPEN'))
    `);
  },
};
