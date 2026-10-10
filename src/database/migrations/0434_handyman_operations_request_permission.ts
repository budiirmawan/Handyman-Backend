import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W02 PART 02A — Operations Queue authority.
 *
 * 1. Catalogue: `handyman.operations.request.read` is registered in the
 *    existing `permissions` catalogue. It is an exceptional Operations
 *    authority and is listed in UNASSIGNED_BY_DEFAULT_PERMISSION_CODES, so no
 *    role (including PLATFORM_ADMIN) inherits it. Production role provisioning
 *    is a deliberate administrative act, not a migration side effect.
 *
 * 2. No role assignment and no grant is created here. `tenant_company.read`
 *    is NOT the Operations queue authority any more.
 */
export const migration0434HandymanOperationsRequestPermission: Migration = {
  id: '0434_handyman_operations_request_permission',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      INSERT INTO permissions (id, code, name, status)
      VALUES (gen_random_uuid(), 'handyman.operations.request.read',
              'Read Handyman Operations Request Queue', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING;
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM permissions
       WHERE code = 'handyman.operations.request.read'
         AND NOT EXISTS (SELECT 1 FROM role_permission_assignments r WHERE r.permission_id = permissions.id);
    `);
  },
};
