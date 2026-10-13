import type { Pool, PoolClient } from 'pg';
import { readTenantSlotSecret } from './handyman-tenant-slot-assertion';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2 — fail-closed BM slot-consent authority.
 *
 * Confirmation is available only when at least one BM integration is ACTIVE,
 * explicitly granted `tenant_slot_choice_scope` in the registry, AND has its
 * purpose-specific secret deployed. The registry default is FALSE and this
 * change grants no integration. Activation is therefore an explicit BM
 * provisioning act, not a code path.
 */
export async function tenantSlotConsentAuthorityConfigured(
  executor: Pick<Pool | PoolClient, 'query'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const result = await executor.query<{ integrationCode: string }>(
    `SELECT integration_code AS "integrationCode"
       FROM handyman_handoff_integrations
      WHERE status = 'ACTIVE' AND tenant_slot_choice_scope = TRUE`,
  );
  return result.rows.some(row => readTenantSlotSecret(row.integrationCode, env) !== null);
}
