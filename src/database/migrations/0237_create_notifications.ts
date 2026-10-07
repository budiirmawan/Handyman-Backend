import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26A — Notification foundation.
 *
 * Creates the shared notification record: an append-only, recipient-scoped
 * in-app notification bound to the platform identity (`users`) and the
 * Client it belongs to. Notifications REACT to existing operational events;
 * the source/domain reference (`source_entity_type` / `source_entity_id` /
 * `source_event_type`) links each record back to the operational entity and
 * event that produced it — operational modules remain the source of truth.
 *
 * Only the IN_APP channel exists in this foundation. No push, email,
 * WhatsApp/SMS delivery, no provider integration, and no delivery/retry
 * state are modeled here (those arrive in later BE-26 parts).
 *
 * Read lifecycle is UNREAD → READ (`read_at` is set exactly once). Rows are
 * never updated for content and never hard-deleted through the foundation.
 *
 * Client / Building isolation: every record carries `client_id`; reads are
 * scoped to the authenticated recipient (`recipient_user_id`) through the
 * BE-02G context access conventions in the service layer.
 */
export const migration0237CreateNotifications: Migration = {
  id: '0237_create_notifications',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notifications (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        recipient_user_id  UUID NOT NULL REFERENCES users (id),
        type               TEXT NOT NULL,
        channel            TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'UNREAD',
        title              TEXT NOT NULL,
        body               TEXT,
        source_entity_type TEXT NOT NULL,
        source_entity_id   UUID NOT NULL,
        source_event_type  TEXT,
        metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at            TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notifications_channel_check
          CHECK (channel IN ('IN_APP')),
        CONSTRAINT notifications_status_check
          CHECK (status IN ('UNREAD', 'READ'))
      )
    `);

    await client.query(`
      CREATE INDEX notifications_recipient_idx
        ON notifications (recipient_user_id, status, created_at DESC);
      CREATE INDEX notifications_client_idx
        ON notifications (client_id, created_at DESC);
      CREATE INDEX notifications_source_idx
        ON notifications (source_entity_type, source_entity_id, created_at DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notifications');
  },
};
