import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-25L — Mobile push token registration.
 *
 * Registers a device's push notification token against the authenticated
 * user. Token refresh/rotation is supported by updating the token value on
 * the user's active device row (one ACTIVE device per (user, deviceId));
 * deactivation/unregistration sets the row INACTIVE. No notification
 * delivery engine exists yet (BE-26).
 *
 * The user/device reference is bound to the authenticated user; Client /
 * Building isolation is preserved by scoping reads through the BE-02G
 * accessible set in the service layer.
 */
export const migration0235CreateMobilePushTokens: Migration = {
  id: '0235_create_mobile_push_tokens',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE mobile_push_tokens (
        id            UUID PRIMARY KEY,
        user_id       UUID NOT NULL REFERENCES users (id),
        device_id     TEXT NOT NULL,
        push_token    TEXT NOT NULL,
        platform      TEXT NOT NULL,
        app_version   TEXT,
        device_model  TEXT,
        device_os_version TEXT,
        status        TEXT NOT NULL DEFAULT 'ACTIVE',
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT mobile_push_tokens_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT mobile_push_tokens_platform_check
          CHECK (platform IN ('ANDROID', 'IOS')),
        CONSTRAINT mobile_push_tokens_user_device_active_unique
          UNIQUE (user_id, device_id, status)
      )
    `);

    await client.query(`
      CREATE INDEX mobile_push_tokens_user_idx
        ON mobile_push_tokens (user_id, status);
      CREATE INDEX mobile_push_tokens_token_idx
        ON mobile_push_tokens (push_token);
      -- One ACTIVE registration per (user, device); token rotation updates
      -- the existing active row instead of inserting a duplicate. The same
      -- push token can never be ACTIVE twice for one user (a re-registered
      -- token from another device replaces the old device's row).
      CREATE UNIQUE INDEX mobile_push_tokens_user_token_active_unique
        ON mobile_push_tokens (user_id, push_token)
        WHERE status = 'ACTIVE';
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS mobile_push_tokens');
  },
};
