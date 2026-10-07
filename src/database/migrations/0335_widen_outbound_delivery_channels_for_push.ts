import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PUSH-01 PART 03A — PUSH channel widening on the outbound ledger.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §10.2, §11.2, §12.7.
 *
 * This is the reserved `0335` migration and it does exactly ONE thing: it
 * replaces the `notification_outbound_deliveries` channel CHECK so the
 * EXISTING ledger (migration 0298) admits `'PUSH'` alongside `'EMAIL'` and
 * `'WHATSAPP'`.
 *
 * WHY A MIGRATION IS REQUIRED HERE
 * --------------------------------
 * The 0298 constraint is `CHECK (channel IN ('EMAIL','WHATSAPP'))`. Widening
 * the TypeScript vocabulary alone would produce rows the database rejects at
 * INSERT time, so the CHECK is the one piece of schema that genuinely has to
 * move for PUSH to exist as a ledger channel. Nothing else about the table
 * changes.
 *
 * WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (PART 03B and later)
 * -----------------------------------------------------------------
 *   - it creates NO table — the reserved `0336` per-device attempt storage
 *     belongs to PART 03B, together with fan-out;
 *   - it adds NO column — no device counter, no accepted counter (§20 D-06
 *     prefers attempt-row aggregation over a new column);
 *   - it adds NO index — PUSH rows are enumerated by the SAME due-window
 *     index the other channels already use;
 *   - it touches NO other constraint. In particular the idempotency
 *     constraint `UNIQUE (client_id, channel, idempotency_key)` is left
 *     exactly as 0298 wrote it: because `channel` is already part of that
 *     key, admitting PUSH cannot collide with an existing EMAIL/WHATSAPP row
 *     (§11.2) and duplicate suppression keeps working unchanged.
 *
 * The new CHECK is a strict SUPERSET of the old one, so every pre-existing
 * EMAIL/WHATSAPP row remains valid and no data is read, rewritten, or moved.
 *
 * REVERSIBILITY
 * -------------
 * `down` restores the exact 0298 predicate. A narrower CHECK cannot be
 * installed while PUSH rows exist, so `down` first removes PUSH ledger rows.
 * Any attempt-history row that referenced one keeps its immutable evidence:
 * the 0299 `delivery_id` foreign key is `ON DELETE SET NULL`, so the linkage
 * is dropped without deleting history. PUSH rows are delivery INTENTS owned
 * solely by this CR: no EMAIL or WHATSAPP row, and no row belonging to
 * another authority, is ever touched.
 */
export const migration0335WidenOutboundDeliveryChannelsForPush: Migration = {
  id: '0335_widen_outbound_delivery_channels_for_push',

  async up(client: PoolClient): Promise<void> {
    // Replaced, not layered: a second CHECK would leave the old, narrower
    // predicate in force and silently keep rejecting PUSH.
    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        DROP CONSTRAINT notification_outbound_deliveries_channel_check
    `);
    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        ADD CONSTRAINT notification_outbound_deliveries_channel_check
          CHECK (channel IN ('EMAIL', 'WHATSAPP', 'PUSH'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // PUSH rows are exclusively this CR's own delivery intents; they must go
    // before the narrower predicate can hold again. EMAIL / WHATSAPP rows are
    // never in scope of this statement.
    await client.query(`
      DELETE FROM notification_outbound_deliveries WHERE channel = 'PUSH'
    `);
    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        DROP CONSTRAINT notification_outbound_deliveries_channel_check
    `);
    await client.query(`
      ALTER TABLE notification_outbound_deliveries
        ADD CONSTRAINT notification_outbound_deliveries_channel_check
          CHECK (channel IN ('EMAIL', 'WHATSAPP'))
    `);
  },
};
