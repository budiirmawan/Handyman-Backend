import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BM-CARE-AUTH-01 — Building Customer Care authority capability.
 *
 * Business baseline: TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN. The
 * Building Customer Care actor is the operational bridge, and the Backend
 * must be able to prove — per request — WHO that actor is and WHICH exact
 * Building they may mediate. That proof is "Authority A".
 *
 * Authority A is deliberately NOT Authority B. It establishes identity and
 * Building reach only. It never establishes that a Tenant approved a
 * Quotation, a Variation or a BAST.
 *
 * This migration registers exactly ONE permission:
 *
 *   handyman.care.building — act as the Building Customer Care actor for an
 *     assigned Building (mediation bridge only).
 *
 * Additive only, following the `handyman.bast.manage` (0446) and
 * `handyman.finance.manage` (0448) precedents:
 *
 *   - Granted to NO role by this migration and to NO role by the foundation
 *     seed (see UNASSIGNED_BY_DEFAULT_PERMISSION_CODES): not Customer Care,
 *     not Tenant PIC, not Dispatcher, not Crew Lead, not generic Operations,
 *     and not even PLATFORM_ADMIN. Enabling a Care persona is a deliberate,
 *     audited administrative grant.
 *   - The permission alone authorizes nothing out of scope: the runtime
 *     additionally requires an ACTIVE assignment to the EXACT Building under
 *     the server-derived Client.
 *   - Generic `tenant_company.manage` is NOT a substitute and is never
 *     consulted by the Authority A resolver.
 *
 * Why the dedicated capability is genuinely missing (not merely ungranted):
 * the only `CUSTOMER_CARE` concept that existed before this change lives in
 * the BM handoff integration model —
 * `handyman_handoff_integrations.actor_capability` and
 * `handyman_handoff_care_actors` (migrations 0425-0430). Those rows identify
 * a Care operator INSIDE a BM integration. They carry no local user, no
 * session, no RBAC role and no Building assignment, so they cannot express
 * "this authenticated Backend actor may mediate THIS Building". Nothing in
 * `permissions` covered it either.
 *
 * No table is created and no column is added: `user_building_assignments`
 * (0019) already carries the ACTIVE membership, and `clients`/`properties`/
 * `buildings` already carry the isolation chain. This migration adds the one
 * missing capability and nothing else.
 *
 * Migration 0449 is intentionally NOT claimed. It remains reserved for the
 * Care Decisions schema (`handyman_care_decisions`), which is a DRAFT that
 * must stay unbuilt and unactivated until Authority B and the verified
 * evidence contract are both sufficient. Adding RBAC does not activate it.
 */
const PERMISSIONS: readonly (readonly [string, string])[] = [
  [
    'handyman.care.building',
    'Act as the Building Customer Care actor for an assigned Building (mediation bridge only)',
  ],
];

export const migration0450HandymanCareBuildingAuthorityPermission: Migration = {
  id: '0450_handyman_care_building_authority_permission',
  async up(tx: PoolClient): Promise<void> {
    // No role receives this capability by migration or foundation seed.
    for (const [code, name] of PERMISSIONS) {
      await tx.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE') ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }
  },
  async down(_tx: PoolClient): Promise<void> {
    // Capability catalogue entries remain: deleting permissions on rollback
    // could invalidate grants. Rollback never grants or revokes actor rights
    // (0442/0446/0448 precedent).
  },
};
