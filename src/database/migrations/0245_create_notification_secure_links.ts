import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-26J — Notification secure link foundation.
 *
 * A secure link is an opaque, recipient-bound, single-purpose reference to a
 * target resource + action. The raw token is returned once and NEVER stored —
 * only its SHA-256 hash is persisted (the BE-01C/BE-01G token convention).
 * The raw token does not embed any resource id; the target reference lives
 * server-side and is revealed only after authenticated validation.
 *
 *   - `token_hash`            — SHA-256 of the opaque token (unique),
 *   - `recipient_user_id`     — recipient binding (resolve requires this user),
 *   - `target_entity_type` / `target_entity_id` — the target resource,
 *   - `action`                — the target action (uppercase code),
 *   - `expires_at`            — expiry (expired links are rejected),
 *   - `max_uses` / `used_count` — one-time / limited-use behavior,
 *   - `status`                — ACTIVE / REVOKED / EXPIRED / USED.
 *
 * The link does NOT bypass backend authorization/workflow rules: resolution
 * only validates the token and returns the target; the actual action is
 * performed through normal authorized endpoints. No credentials or sensitive
 * data are embedded.
 */
export const migration0245CreateNotificationSecureLinks: Migration = {
  id: '0245_create_notification_secure_links',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE notification_secure_links (
        id                 UUID PRIMARY KEY,
        token_hash         TEXT NOT NULL,
        client_id          UUID NOT NULL REFERENCES clients (id),
        recipient_user_id  UUID NOT NULL REFERENCES users (id),
        target_entity_type TEXT NOT NULL,
        target_entity_id   UUID NOT NULL,
        action             TEXT NOT NULL,
        expires_at         TIMESTAMPTZ NOT NULL,
        max_uses           INTEGER NOT NULL DEFAULT 1,
        used_count         INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT notification_secure_links_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT notification_secure_links_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED', 'USED')),
        CONSTRAINT notification_secure_links_max_uses_check
          CHECK (max_uses >= 1),
        CONSTRAINT notification_secure_links_used_count_check
          CHECK (used_count >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX notification_secure_links_recipient_idx
        ON notification_secure_links (recipient_user_id, status, created_at DESC);
      CREATE INDEX notification_secure_links_client_idx
        ON notification_secure_links (client_id);
      CREATE INDEX notification_secure_links_target_idx
        ON notification_secure_links (target_entity_type, target_entity_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS notification_secure_links');
  },
};
