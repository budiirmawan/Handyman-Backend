import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05I — Asset History foundation.
 *
 * An APPEND-ORIENTED record of important Asset master-data events across the
 * BE-05 domains: registration, master-data edits, classification, location
 * binding, equipment profile, lifecycle status, warranty, certification, and
 * identifier changes.
 *
 * This is history, not master data: rows are written once and read back. No
 * `updated_at` column exists, because a history entry is never edited — that
 * absence is the schema stating the intent. The API exposes reads only.
 *
 * `actor_user_id` is NULLABLE and `ON DELETE SET NULL`: an event may be
 * recorded by a system path with no authenticated user, and deleting a user
 * must never erase the fact that something happened to the Asset. Ownership
 * context is derived through History → Asset → Building → Property → Client
 * and is not duplicated here.
 *
 * `metadata` is JSONB holding only SAFE, MINIMAL values — changed field
 * names, entity ids, and before/after states. Never credentials, tokens,
 * session material, or Authorization headers; the history service filters
 * this centrally.
 *
 * The event type is stored as free TEXT with an index rather than a CHECK
 * constraint: later Waves will add their own asset-related event types, and
 * widening a CHECK on an append-only table on every Wave would be churn for
 * no integrity gain. The application layer owns the vocabulary.
 *
 * This migration creates NO PM, breakdown, work order, checklist, meter
 * reading, finding/verification, or maintenance-timeline structures.
 */
export const migration0053CreateAssetHistoryEvents: Migration = {
  id: '0053_create_asset_history_events',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_history_events (
        id             UUID PRIMARY KEY,
        asset_id       UUID NOT NULL,
        event_type     TEXT NOT NULL,
        actor_user_id  UUID,
        summary        TEXT NOT NULL,
        metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_history_events_asset_id_fkey
          FOREIGN KEY (asset_id) REFERENCES assets (id),
        CONSTRAINT asset_history_events_actor_user_id_fkey
          FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
      )
    `);

    // The dominant read is "this Asset's timeline, newest first".
    await client.query(
      `CREATE INDEX asset_history_events_asset_id_created_at_idx
         ON asset_history_events (asset_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX asset_history_events_event_type_idx
         ON asset_history_events (event_type)`,
    );
    await client.query(
      `CREATE INDEX asset_history_events_actor_user_id_idx
         ON asset_history_events (actor_user_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_history_events');
  },
};
