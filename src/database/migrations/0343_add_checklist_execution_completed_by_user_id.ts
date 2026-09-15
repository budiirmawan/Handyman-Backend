import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R06 PART 01 — Checklist Completion Actor Authority.
 *
 * Adds the durable completion-actor column to `checklist_executions`:
 *
 *   checklist_executions.completed_by_user_id  →  users.id
 *
 * Contract:
 *   - UUID NULL — historical executions predate completion-actor attribution
 *     and remain NULL. No backfill is performed and none may be inferred from
 *     created_at / updated_at / operational_events /
 *     generated_tasks.completed_by_user_id / reviews.reviewer_user_id /
 *     task assignment / current user profile.
 *   - Referential integrity only: a non-null value must reference an existing
 *     user (NO ACTION, matching the platform operational-reference convention).
 *   - No trigger, no default, no new table, no audit redesign.
 *
 * This PART only adds the completion actor. Assignee/executor snapshot,
 * response actor, verifier, vendor executor, form-engine attribution and
 * Reporting projection are explicitly out of scope.
 */
export const migration0343AddChecklistExecutionCompletedByUserId: Migration = {
  id: '0343_add_checklist_execution_completed_by_user_id',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN completed_by_user_id UUID,
        ADD CONSTRAINT checklist_executions_completed_by_user_id_fkey
          FOREIGN KEY (completed_by_user_id) REFERENCES users (id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        DROP CONSTRAINT IF EXISTS checklist_executions_completed_by_user_id_fkey,
        DROP COLUMN IF EXISTS completed_by_user_id
    `);
  },
};
