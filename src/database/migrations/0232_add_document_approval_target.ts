import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22I — Approval via shared Document foundation.
 * Reuses BE-09 approval/workflow foundation (reviews + available_actions).
 * Adds DOCUMENT and DOCUMENT_VERSION as review targets and seeds document.approve.
 */
export const migration0232AddDocumentApprovalTarget: Migration = {
  id: '0232_add_document_approval_target',

  async up(client: PoolClient): Promise<void> {
    // Extend review_target to include DOCUMENT and DOCUMENT_VERSION (additive, never subset)
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (
          'FORM_INSTANCE',
          'CHECKLIST_EXECUTION',
          'WORK_ORDER',
          'FINDING',
          'VENDOR_WORK',
          'UTILITY_ABNORMAL_CONSUMPTION',
          'PERMIT_APPLICATION',
          'DOCUMENT',
          'DOCUMENT_VERSION'
        )
      );
    `);

    // Seed document.approve permission
    await client.query(
      `INSERT INTO permissions (id, code, name, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       ON CONFLICT (code) DO NOTHING`,
      [randomUUID(), 'document.approve', 'Approve Documents'],
    );

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
    );
    const roleId = roleResult.rows[0]?.id;
    if (roleId) {
      const permResult = await client.query<{ id: string }>(
        `SELECT id FROM permissions WHERE code = 'document.approve'`,
      );
      const permId = permResult.rows[0]?.id;
      if (permId) {
        await client.query(
          `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
           SELECT $1, $2, $3, 'ACTIVE'
           WHERE NOT EXISTS (
             SELECT 1 FROM role_permission_assignments
             WHERE role_id = $2 AND permission_id = $3 AND status = 'ACTIVE'
           )`,
          [randomUUID(), roleId, permId],
        );
      }
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DELETE FROM reviews WHERE target_type IN ('DOCUMENT', 'DOCUMENT_VERSION')`);
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (
          'FORM_INSTANCE',
          'CHECKLIST_EXECUTION',
          'WORK_ORDER',
          'FINDING',
          'VENDOR_WORK',
          'UTILITY_ABNORMAL_CONSUMPTION',
          'PERMIT_APPLICATION'
        )
      );
    `);
  },
};
