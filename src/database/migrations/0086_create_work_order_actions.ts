import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08F — Work Order Execution Actions.
 *
 * Lightweight, append-only execution-action log for generic Work Order
 * actions (acknowledge, start, hold, resume, note, cancel). Each action is
 * validated against the BE-08C lifecycle (transitionWorkOrderStatus) and the
 * BE-08E active assignment at the service layer; this table only persists the
 * action record. Completion, evidence, verification, and audit/history are
 * later BE-08 PARTs and are deliberately absent.
 */
export const migration0086CreateWorkOrderActions: Migration = {
  id: '0086_create_work_order_actions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_order_actions (
        id UUID PRIMARY KEY,
        work_order_id UUID NOT NULL REFERENCES work_orders (id),
        action_type TEXT NOT NULL,
        actor_user_id UUID NOT NULL REFERENCES users (id),
        notes TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_order_action_type
          CHECK (action_type IN
            ('ACKNOWLEDGED', 'STARTED', 'ON_HOLD', 'RESUMED', 'NOTE_ADDED',
             'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE INDEX work_order_actions_work_order_idx
        ON work_order_actions (work_order_id, occurred_at);
      CREATE INDEX work_order_actions_actor_idx
        ON work_order_actions (actor_user_id, occurred_at);
      CREATE INDEX work_order_actions_type_idx
        ON work_order_actions (action_type, occurred_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_order_actions');
  },
};
