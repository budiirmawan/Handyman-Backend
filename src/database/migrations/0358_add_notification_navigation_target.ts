import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — Backend-owned notification navigation target.
 *
 * Adds an EXPLICIT, backend-owned navigation target to the BE-26A notification
 * record. Until now a client could only guess where a notification points by
 * interpreting `source_entity_type` / `source_entity_id` — free-form,
 * non-enumerated identity fields that are NOT a navigation contract. These two
 * columns are the governed replacement for that guess.
 *
 * DECISION OWNERSHIP
 * ------------------
 * Only a producer that knows the canonical backend entity writes these
 * columns. They are NEVER derived, inferred or copied from `source_entity_type`
 * / `source_entity_id` / `metadata` — a notification whose producer states no
 * target keeps both columns NULL and resolves to no navigation target.
 *
 * SCOPE OF THIS CR
 * ----------------
 * Exactly one target type exists: `WORK_ORDER_FIELD_WORK`, emitted only by the
 * existing canonical runtime producer (SLA escalation → `work_orders.id`).
 * The CHECK is the closed vocabulary — an ungoverned target type cannot be
 * persisted, and a type can never exist without its id.
 *
 * BOTH NULL  /  (type = 'WORK_ORDER_FIELD_WORK' AND id IS NOT NULL)
 *
 * The `navigation_target_type IS NOT NULL` conjunct in the second branch is
 * LOAD-BEARING, not decoration: in SQL a CHECK passes when its expression
 * evaluates to NULL, and `NULL = 'WORK_ORDER_FIELD_WORK'` is NULL rather than
 * false — so a row with a NULL type and a non-null id would slip through
 * without it.
 *
 * EXISTING ROWS stay NULL. There is deliberately NO BACKFILL: retro-fitting a
 * target onto historical notifications would be the backend inventing a
 * navigation decision the original producer never made.
 */
export const migration0358AddNotificationNavigationTarget: Migration = {
  id: '0358_add_notification_navigation_target',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notifications
        ADD COLUMN navigation_target_type TEXT,
        ADD COLUMN navigation_target_id UUID
    `);

    await client.query(`
      ALTER TABLE notifications
        ADD CONSTRAINT notifications_navigation_target_check
          CHECK (
            (
              navigation_target_type IS NULL
              AND navigation_target_id IS NULL
            )
            OR (
              navigation_target_type IS NOT NULL
              AND navigation_target_type = 'WORK_ORDER_FIELD_WORK'
              AND navigation_target_id IS NOT NULL
            )
          )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notifications
        DROP CONSTRAINT IF EXISTS notifications_navigation_target_check
    `);
    await client.query(`
      ALTER TABLE notifications
        DROP COLUMN IF EXISTS navigation_target_id,
        DROP COLUMN IF EXISTS navigation_target_type
    `);
  },
};
