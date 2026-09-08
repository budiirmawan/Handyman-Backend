import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20F — Permit Approval Binding.
 *
 * Reuses the shared BE-07/BE-09 `reviews` decision engine. This migration
 * widens its target vocabulary for a Permit Application and adds only a thin
 * binding for approval stage/type. Decision, approver, PENDING/COMPLETED
 * state, notes and decision timestamp remain authoritative on `reviews`.
 */
export const migration0207CreatePermitApprovalBindings: Migration = {
  id: '0207_create_permit_approval_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
          'VENDOR_WORK', 'UTILITY_ABNORMAL_CONSUMPTION',
          'PERMIT_APPLICATION'
        )
      )
    `);

    await client.query(`
      CREATE TABLE permit_approval_bindings (
        id                    UUID PRIMARY KEY,
        permit_application_id UUID NOT NULL REFERENCES permit_applications (id),
        review_id             UUID NOT NULL REFERENCES reviews (id),
        approval_stage        TEXT NOT NULL,
        approval_type         TEXT NOT NULL,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_approval_review_unique UNIQUE (review_id),
        CONSTRAINT permit_approval_context_unique
          UNIQUE (permit_application_id, approval_stage, approval_type)
      )
    `);

    await client.query(`
      CREATE INDEX permit_approval_application_idx
        ON permit_approval_bindings (permit_application_id, created_at);
      CREATE INDEX permit_approval_stage_type_idx
        ON permit_approval_bindings (approval_stage, approval_type)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_approval_bindings');
    await client.query(
      "DELETE FROM reviews WHERE target_type = 'PERMIT_APPLICATION'",
    );
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
          'VENDOR_WORK', 'UTILITY_ABNORMAL_CONSUMPTION'
        )
      )
    `);
  },
};
