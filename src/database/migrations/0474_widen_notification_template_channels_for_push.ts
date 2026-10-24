import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — push template channel (S-5 /
 * F-1).
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-5).
 *
 * WHAT THIS MIGRATION DOES — EXACTLY ONE THING
 * ---------------------------------------------
 * It replaces the `notification_templates` channel CHECK so the template
 * store admits `'PUSH'` alongside `'IN_APP'`, `'EMAIL'` and `'WHATSAPP'`.
 *
 * WHY IT IS REQUIRED
 * ------------------
 * The outbound intent chain (BE-26F / CR-BE-PUSH-01 PART 03A) creates a
 * delivery intent for a SUBSCRIPTION whose template's channel is one of the
 * requested outbound channels. The ledger already admits the PUSH channel
 * (migration 0335) and the execution engine already sends it (PART 03C/04),
 * but the template store's CHECK still said `('IN_APP','EMAIL','WHATSAPP')`:
 * a PUSH template could not exist, therefore NO push intent could ever be
 * produced, therefore the whole push transport (native AND browser) was
 * unreachable from a real event.
 *
 * This is the missing link between the existing push transport and the
 * notification engine — not a new transport, and not a new channel in the
 * ledger (0335 already did that).
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   - it does NOT widen the `notifications` (in-app inbox) channel CHECK:
 *     the inbox stays `IN_APP` only, because a push delivery is not an inbox
 *     record (governance §3.5 — inbound records and outbound intents are
 *     separate authorities),
 *   - it does NOT touch `notification_outbound_deliveries` (0335 owns the
 *     ledger's channel vocabulary),
 *   - it does NOT create a table, a column or an index,
 *   - it does NOT change any existing template row.
 *
 * The new CHECK is a strict SUPERSET of the old one, so every pre-existing
 * IN_APP / EMAIL / WHATSAPP template remains valid and no row is read,
 * rewritten or moved.
 *
 * REVERSIBILITY
 * -------------
 * `down` removes the PUSH templates first (a narrower CHECK cannot be
 * installed while PUSH rows exist) and then restores the exact 0300
 * predicate. A PUSH template is a rendering recipe, not evidence, so
 * removing it loses no delivery history: the attempt evidence lives in
 * `notification_push_deliveries` / `notification_browser_push_deliveries`
 * and the delivery state lives in the outbound ledger.
 */
export const migration0474WidenNotificationTemplateChannelsForPush: Migration = {
  id: '0474_widen_notification_template_channels_for_push',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE notification_templates
        DROP CONSTRAINT notification_templates_channel_check
    `);
    await client.query(`
      ALTER TABLE notification_templates
        ADD CONSTRAINT notification_templates_channel_check
          CHECK (channel IN ('IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM notification_templates WHERE channel = 'PUSH'
    `);
    await client.query(`
      ALTER TABLE notification_templates
        DROP CONSTRAINT notification_templates_channel_check
    `);
    await client.query(`
      ALTER TABLE notification_templates
        ADD CONSTRAINT notification_templates_channel_check
          CHECK (channel IN ('IN_APP', 'EMAIL', 'WHATSAPP'))
    `);
  },
};
