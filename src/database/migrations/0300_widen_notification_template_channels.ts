import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 03 — template channel widening.
 *
 * Additive widening of the BE-26B template channel vocabulary from
 * `IN_APP`-only to `IN_APP | EMAIL | WHATSAPP`, exactly as the START
 * GOVERNANCE §12 PART 03 defines. An EMAIL / WHATSAPP template is the
 * rendering recipe for an outbound delivery intent: the outbound intent
 * orchestration (PART 03) renders it ONCE at intent time and snapshots the
 * result onto the PART 02 delivery ledger.
 *
 * The constraint is replaced, not layered: the new CHECK is a strict superset
 * of the old one, so every existing IN_APP row remains valid. The
 * `notifications` (in-app inbox) channel CHECK is deliberately NOT widened —
 * inbound in-app records and outbound delivery intents stay separate
 * authorities (governance §3.5).
 *
 * Down restores the IN_APP-only foundation: any EMAIL/WHATSAPP templates are
 * removed first so the narrower constraint can hold.
 */
export const migration0300WidenNotificationTemplateChannels: Migration = {
  id: '0300_widen_notification_template_channels',

  async up(client: PoolClient): Promise<void> {
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

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM notification_templates WHERE channel <> 'IN_APP'
    `);
    await client.query(`
      ALTER TABLE notification_templates
        DROP CONSTRAINT notification_templates_channel_check
    `);
    await client.query(`
      ALTER TABLE notification_templates
        ADD CONSTRAINT notification_templates_channel_check
          CHECK (channel IN ('IN_APP'))
    `);
  },
};
