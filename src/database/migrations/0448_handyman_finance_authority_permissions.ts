import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIN-AUTH-01 — Dedicated Commercial, Finance & Settlement
 * authority for Handyman financial surfaces.
 *
 * Additive only. Registers four explicit domain permissions in the
 * catalogue, following the `handyman.qc.manage` (0442) and
 * `handyman.bast.manage` (0446) precedents:
 *
 *   handyman.commercial.manage — commercial agreement, pricing and
 *     BM-fee authoring, and service-warranty start/expire (commercial
 *     aftercare commitments).
 *   handyman.finance.read      — Handyman financial read surfaces.
 *   handyman.finance.manage    — customer transaction open/charge,
 *     payment allocation, ledger corrections (refund / reversals /
 *     adjustments), entitlement derivation, and payment verification
 *     (confirm / reject of reported payments).
 *   handyman.settlement.manage — settlement ladder (prepare / include /
 *     reconcile / settle / correction / dispute-hold). Settlement
 *     authority never implies refund or allocation authority.
 *
 * Granted to NO role by this migration or by the foundation seed (see
 * UNASSIGNED_BY_DEFAULT_PERMISSION_CODES): not Customer Care, Tenant
 * PIC, Dispatcher, Crew Lead, generic Operations, and not even
 * PLATFORM_ADMIN. Enabling a financial persona is a deliberate,
 * audited administrative grant; the runtime additionally requires
 * Client / exact-Building scope, so a permission alone authorizes
 * nothing out of scope. Generic `tenant_company.manage` alone no
 * longer authorizes these mutations.
 *
 * Customer payment REPORTING (record) and customer ledger reads are
 * intentionally unchanged (`tenant_company.manage` / `.read`):
 * reporting a payment is not Finance verification.
 */
const PERMISSIONS: readonly (readonly [string, string])[] = [
  ['handyman.commercial.manage', 'Author Handyman commercial agreements, pricing and BM-fee terms'],
  ['handyman.finance.read', 'Read Handyman financial transactions'],
  ['handyman.finance.manage', 'Execute Handyman finance commands (ledger, allocations, corrections, payment verification)'],
  ['handyman.settlement.manage', 'Execute Handyman settlement commands'],
];

export const migration0448HandymanFinanceAuthorityPermissions: Migration = {
  id: '0448_handyman_finance_authority_permissions',
  async up(tx: PoolClient): Promise<void> {
    // No role receives these capabilities by migration or foundation seed.
    for (const [code, name] of PERMISSIONS) {
      await tx.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }
  },
  async down(_tx: PoolClient): Promise<void> {
    // Capability catalogue entries remain: deleting permissions on
    // rollback could invalidate grants. Rollback never grants or
    // revokes actor rights (0442/0446 precedent).
  },
};
