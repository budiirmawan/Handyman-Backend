import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — per-subscription browser push
 * attempt evidence (S-6).
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-6) — the ledger row stays device-agnostic; the SUBSCRIPTION is a
 * send-time concern, exactly like the native device selection.
 *
 * WHY A SEPARATE ATTEMPT TABLE
 * -----------------------------
 * The native attempt table (`notification_push_deliveries`, migration 0336)
 * carries `push_token_id UUID NOT NULL REFERENCES mobile_push_tokens (id)`
 * and `platform CHECK (platform IN ('ANDROID','IOS'))`. A browser
 * subscription is neither: it references `browser_push_subscriptions` and its
 * platform is the browser.
 *
 * The two attempt tables are kept apart on purpose:
 *   - the frozen 0336 shape is NOT widened (its FK, its platform CHECK and
 *     its indexes stay exactly as the CR-BE-PUSH-01 governance froze them),
 *   - a browser attempt can never be mistaken for a native device attempt,
 *   - the two transports keep independent evidence even though they share
 *     ONE ledger row per recipient.
 *
 * WHAT A ROW IS
 * --------------
 * Immutable evidence of ONE send to ONE browser subscription: what was sent,
 * which provider accepted or rejected it, and the normalized error code.
 * It is never a queue entry, never a retry cursor, and never authoritative
 * for delivery state — the outbound ledger remains the single source of truth
 * for that, and the existing retry engine owns the schedule.
 *
 * SECRETS
 * -------
 * The row references the subscription by id (`browser_subscription_id`). It
 * NEVER stores the endpoint, the subscriber's public key or the auth secret,
 * so the delivery audit trail cannot be used to reconstruct a credential.
 *
 * ADDITIVE ONLY
 * -------------
 * One table and its indexes. No existing table, column, constraint or row is
 * touched.
 */
export const migration0475CreateNotificationBrowserPushDeliveries: Migration = {
  id: '0475_create_notification_browser_push_deliveries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_browser_push_deliveries (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID REFERENCES buildings (id),
        recipient_user_id       UUID NOT NULL REFERENCES users (id),
        browser_subscription_id UUID NOT NULL REFERENCES browser_push_subscriptions (id),
        device_id               TEXT NOT NULL,
        platform                TEXT NOT NULL DEFAULT 'BROWSER',
        template_key            TEXT REFERENCES notification_templates (key),
        title                   TEXT NOT NULL,
        body                    TEXT,
        status                  TEXT NOT NULL,
        provider                TEXT NOT NULL,
        provider_reference      TEXT,
        error_message           TEXT,
        error_code              TEXT,
        sent_at                 TIMESTAMPTZ,
        delivery_id             UUID REFERENCES notification_outbound_deliveries (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_browser_push_deliveries_status_check
          CHECK (status IN ('SENT', 'FAILED')),
        CONSTRAINT notification_browser_push_deliveries_platform_check
          CHECK (platform = 'BROWSER'),
        CONSTRAINT notification_browser_push_deliveries_title_check
          CHECK (char_length(title) <= 200),
        CONSTRAINT notification_browser_push_deliveries_body_check
          CHECK (body IS NULL OR char_length(body) <= 500),
        CONSTRAINT notification_browser_push_deliveries_error_message_check
          CHECK (error_message IS NULL OR char_length(error_message) <= 500)
      )
    `);

    await client.query(`
      CREATE INDEX notification_browser_push_deliveries_recipient_idx
        ON notification_browser_push_deliveries (recipient_user_id)
    `);
    await client.query(`
      CREATE INDEX notification_browser_push_deliveries_client_idx
        ON notification_browser_push_deliveries (client_id)
    `);
    await client.query(`
      CREATE INDEX notification_browser_push_deliveries_delivery_idx
        ON notification_browser_push_deliveries (delivery_id)
    `);
    await client.query(`
      CREATE INDEX notification_browser_push_deliveries_subscription_idx
        ON notification_browser_push_deliveries (browser_subscription_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS notification_browser_push_deliveries_subscription_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS notification_browser_push_deliveries_delivery_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS notification_browser_push_deliveries_client_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS notification_browser_push_deliveries_recipient_idx
    `);
    await client.query(`
      DROP TABLE IF EXISTS notification_browser_push_deliveries
    `);
  },
};
