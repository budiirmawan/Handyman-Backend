import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R06 PART 04B — Form Response Latest Writer Authority.
 *
 * Mirrors the closed checklist authority (R06 PART 03B) onto `form_responses`
 * with EXACT semantic parity:
 *
 *   form_responses.last_responded_by_user_id  →  users.id
 *
 * Exact meaning: the authenticated user whose successful response mutation
 * MOST RECENTLY wrote this response row. It does NOT mean first responder,
 * original responder, full edit history, executor, assignee, completion
 * actor, or verifier.
 *
 * Contract:
 *   - UUID NULL — historical rows predate response-actor attribution and
 *     remain NULL. No backfill, no trigger, no history table.
 *   - Referential integrity only: a non-null value must reference an existing
 *     user (NO ACTION, matching the platform operational-reference convention).
 */
export const migration0347AddFormResponseLastRespondedByUserId: Migration = {
  id: '0347_add_form_response_last_responded_by_user_id',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_responses
        ADD COLUMN last_responded_by_user_id UUID,
        ADD CONSTRAINT form_responses_last_responded_by_user_id_fkey
          FOREIGN KEY (last_responded_by_user_id) REFERENCES users (id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_responses
        DROP CONSTRAINT IF EXISTS form_responses_last_responded_by_user_id_fkey,
        DROP COLUMN IF EXISTS last_responded_by_user_id
    `);
  },
};
