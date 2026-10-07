import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R06 PART 03B — Checklist Latest Response Writer Authority.
 *
 * Adds the latest-response-writer column to `checklist_item_responses`:
 *
 *   checklist_item_responses.last_responded_by_user_id  →  users.id
 *
 * Exact meaning: the authenticated user whose successful response mutation
 * MOST RECENTLY wrote this response row (on initial INSERT and on every
 * subsequent ON CONFLICT DO UPDATE). It does NOT preserve the first
 * responder, the original responder, or full response edit history.
 *
 * Contract:
 *   - UUID NULL — historical rows predate response-actor attribution and
 *     remain NULL. No backfill, no trigger, no history table.
 *   - Referential integrity only: a non-null value must reference an
 *     existing user (NO ACTION, platform operational-reference convention).
 */
export const migration0345AddChecklistResponseLastRespondedByUserId: Migration = {
  id: '0345_add_checklist_response_last_responded_by_user_id',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_item_responses
        ADD COLUMN last_responded_by_user_id UUID,
        ADD CONSTRAINT checklist_item_responses_last_responded_by_user_id_fkey
          FOREIGN KEY (last_responded_by_user_id) REFERENCES users (id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_item_responses
        DROP CONSTRAINT IF EXISTS checklist_item_responses_last_responded_by_user_id_fkey,
        DROP COLUMN IF EXISTS last_responded_by_user_id
    `);
  },
};
