import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push subscription
 * authority (S-1).
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-1) — the WEB_PUSH governance supersession granted by
 * `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` §16.3-A (2026-10-24).
 *
 * WHY A NEW TABLE (S-1) AND NOT A ROW IN `mobile_push_tokens`
 * -----------------------------------------------------------
 * A native device registration and a browser subscription are DIFFERENT
 * objects and must not share one vocabulary:
 *
 *   - `mobile_push_tokens` holds an opaque provider TOKEN and a `platform`
 *     CHECK of ('ANDROID','IOS'). A browser subscription is not a token: it
 *     is a three-part object (an endpoint URL plus the subscriber's public
 *     key and auth secret) with its own lifecycle (the browser rotates the
 *     key pair, the push service expires the endpoint, an unsubscribe
 *     invalidates it).
 *   - Faking a browser as a `platform` value would make the native fan-out
 *     try to send an endpoint URL to the native transport, and would make the
 *     native attempt-evidence table reference a row that does not exist.
 *
 * So the browser has its OWN registration authority, its OWN lifecycle
 * vocabulary and its OWN attempt-evidence table (migration 0475).
 *
 * THE CONTRACT (client-neutral)
 * ------------------------------
 * A row is the browser's OWN registration: it is bound to the authenticated
 * user (never a client-supplied user id) and to a device label, so the same
 * browser can rotate its key pair without creating a second registration.
 * The row carries NO tenant id: the tenant is inherited from the already
 * authorized recipient at send time, exactly like the native registration.
 *
 * SECRETS
 * -------
 * `endpoint`, `p256dh` and `auth` are credential-grade values (the endpoint
 * is a capability URL). They are stored because delivery needs them, they are
 * never logged, never returned by a public API shape, and the attempt
 * evidence table (0475) references the row by id instead of copying them.
 *
 * LIFECYCLE
 * ---------
 *   ACTIVE   — the browser may be targeted right now.
 *   INACTIVE — the user revoked the registration (kept as history).
 *   INVALID  — the push service proved the subscription is gone (404/410),
 *              kept as evidence with its provenance.
 *
 * Rows are NEVER deleted: unregister, invalidation and rotation all retain
 * the history. A re-registration ROTATES the ACTIVE row of the same
 * (user, device) pair, and an endpoint that reappears under another account
 * retires the previous ACTIVE row — the same global uniqueness rule the
 * native registration follows, so one subscription can never route to two
 * active users.
 *
 * ADDITIVE ONLY
 * -------------
 * This migration creates ONE table and its indexes. It touches no existing
 * table, column, constraint or row: `mobile_push_tokens`,
 * `notification_templates`, `notification_outbound_deliveries` and the
 * `notifications` inbox are all exactly as migration 0472 left them.
 */
export const migration0473CreateBrowserPushSubscriptions: Migration = {
  id: '0473_create_browser_push_subscriptions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE browser_push_subscriptions (
        id            UUID PRIMARY KEY,
        user_id       UUID NOT NULL REFERENCES users (id),
        device_id     TEXT NOT NULL,
        endpoint      TEXT NOT NULL,
        p256dh        TEXT NOT NULL,
        auth          TEXT NOT NULL,
        user_agent    TEXT,
        status        TEXT NOT NULL DEFAULT 'ACTIVE',
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        provider      TEXT,
        last_success_at TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ,
        consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
        invalidated_at TIMESTAMPTZ,
        invalidation_reason TEXT,
        CONSTRAINT browser_push_subscriptions_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE', 'INVALID')),
        CONSTRAINT browser_push_subscriptions_invalid_evidence_check
          CHECK (status <> 'INVALID' OR invalidated_at IS NOT NULL),
        CONSTRAINT browser_push_subscriptions_failure_count_check
          CHECK (consecutive_failure_count >= 0)
      )
    `);

    // One ACTIVE registration per (user, browser device label): a re-
    // registration rotates the row instead of stacking duplicates.
    await client.query(`
      CREATE UNIQUE INDEX browser_push_subscriptions_user_device_active_idx
        ON browser_push_subscriptions (user_id, device_id)
       WHERE status = 'ACTIVE'
    `);

    // One ACTIVE registration per endpoint, GLOBALLY: a subscription that
    // reappears under another account retires the previous owner, so one
    // browser subscription can never route to two active users.
    await client.query(`
      CREATE UNIQUE INDEX browser_push_subscriptions_endpoint_active_idx
        ON browser_push_subscriptions (endpoint)
       WHERE status = 'ACTIVE'
    `);

    // The fan-out lookup: the ACTIVE subscriptions of one recipient.
    await client.query(`
      CREATE INDEX browser_push_subscriptions_user_idx
        ON browser_push_subscriptions (user_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // The attempt-evidence table (0475) references this table; it is dropped
    // first when the whole sequence is rolled back, so dropping here is safe.
    await client.query(`
      DROP INDEX IF EXISTS browser_push_subscriptions_user_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS browser_push_subscriptions_endpoint_active_idx
    `);
    await client.query(`
      DROP INDEX IF EXISTS browser_push_subscriptions_user_device_active_idx
    `);
    await client.query(`
      DROP TABLE IF EXISTS browser_push_subscriptions
    `);
  },
};
