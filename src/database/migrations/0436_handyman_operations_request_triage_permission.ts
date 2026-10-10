import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W02 PART 04A — Operations triage authority separation.
 *
 * 1. Catalogue: `handyman.operations.request.triage` is registered in the
 *    existing `permissions` catalogue. It authorizes POST triage for Operations
 *    and is deliberately NOT derived from `tenant_company.manage` (the
 *    administrative tenant-company permission).
 * 2. No role assignment and no grant is created here. The code is listed in
 *    UNASSIGNED_BY_DEFAULT_PERMISSION_CODES, so no role (including
 *    PLATFORM_ADMIN) inherits it. Provisioning is an explicit administrative act.
 * 3. Additive only: no existing permission, grant or row is changed.
 */
export const migration0436HandymanOperationsRequestTriagePermission: Migration = {
  id: '0436_handyman_operations_request_triage_permission',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      INSERT INTO permissions (id, code, name, status)
      VALUES (gen_random_uuid(), 'handyman.operations.request.triage',
              'Triage Handyman Operations Requests', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING;
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM permissions
       WHERE code = 'handyman.operations.request.triage'
         AND NOT EXISTS (SELECT 1 FROM role_permission_assignments r WHERE r.permission_id = permissions.id);
    `);
  },
};
