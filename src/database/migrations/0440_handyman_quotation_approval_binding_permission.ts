import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03B2 — dedicated approval-binding management authority
 * (ADD-A B8 / BLK-BIND-SCOPE, ratified by item 7 of this PART).
 *
 * 1. Catalogue only: `handyman.quotation.approval.binding.manage` is inserted
 *    into the existing `permissions` catalogue. It authorizes the STAFF act of
 *    conferring or revoking who may consent on a quotation thread — an
 *    authority over *who signs*, never *that someone signed* (B9).
 * 2. NO role assignment and NO grant is created here. The code is listed in
 *    `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` in
 *    `src/database/seeds/foundation-access.seed.ts`, so no role — including
 *    PLATFORM_ADMIN — inherits it; provisioning is an explicit administrative
 *    act. `down()` therefore deletes the row only while it carries no
 *    assignment.
 * 3. This is ADD-A §3.3 B8's recorded "deferred hardening" (BLK-BIND-SCOPE,
 *    P1: "must pass the registry gate and the catalogue in a code-bearing
 *    PART") landing in exactly such a PART. It does NOT replace B8's wall: the
 *    routes mount `tenant_company.manage` AND this code AND the exact-Building
 *    BE-02G assignment, so authority only moved in the narrower direction
 *    (reconciliation §9). Existing `manage` holders lose access to nothing
 *    else, and gain nothing here.
 * 4. Additive only: no existing permission, role, grant, or row is changed.
 *    The same statement shape as `0436` (`ON CONFLICT (code) DO NOTHING`) so
 *    the seed and this migration cannot disagree about one row.
 *
 * Registry-gate obligations this migration satisfies by construction: the code
 * is present in `FOUNDATION_PERMISSIONS` (catalogue), in
 * `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` (policy), and the literal enforced
 * at the route is exactly this string (so
 * `tests/config-perm-01-permission-registry.test.ts` resolves it).
 */
export const migration0440HandymanQuotationApprovalBindingPermission: Migration = {
  id: '0440_handyman_quotation_approval_binding_permission',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      INSERT INTO permissions (id, code, name, status)
      VALUES (gen_random_uuid(), 'handyman.quotation.approval.binding.manage',
              'Manage Handyman Quotation Approval Bindings', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING;
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM permissions
       WHERE code = 'handyman.quotation.approval.binding.manage'
         AND NOT EXISTS (SELECT 1 FROM role_permission_assignments r WHERE r.permission_id = permissions.id);
    `);
  },
};
