import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-BAST-01 PART 02 — activate the narrow canonical acceptance authority.
 *
 * Submission attempts were introduced by PART 01. A canonical attempt may now
 * have exactly one Acceptance Sign-Off, and acceptance/rejection is protected
 * by a permission distinct from general document management.
 */
export const migration0260AddCanonicalBastCommands: Migration = {
  id: '0260_add_canonical_bast_commands',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE UNIQUE INDEX acceptance_sign_offs_bast_attempt_unique
        ON acceptance_sign_offs (bast_submission_attempt_id)
        WHERE bast_submission_attempt_id IS NOT NULL
    `);

    await client.query(
      `INSERT INTO permissions (id, code, name, status)
       VALUES ($1, 'bast.accept', 'Accept or Reject BAST', 'ACTIVE')
       ON CONFLICT (code) DO NOTHING`,
      [randomUUID()],
    );

    const role = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
    );
    const roleId = role.rows[0]?.id;
    if (roleId) {
      await client.query(
        `INSERT INTO role_permission_assignments
           (id, role_id, permission_id, status)
         SELECT $1, $2, p.id, 'ACTIVE'
         FROM permissions p
         WHERE p.code = 'bast.accept'
         ON CONFLICT (role_id, permission_id) WHERE status = 'ACTIVE'
         DO NOTHING`,
        [randomUUID(), roleId],
      );
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS acceptance_sign_offs_bast_attempt_unique',
    );
    // Keep the permission and historical role assignments on downgrade.
  },
};
