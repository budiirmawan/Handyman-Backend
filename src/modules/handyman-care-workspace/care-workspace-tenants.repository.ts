import { getPool } from '../../database';
import type { CareWorkspacePrincipal } from './care-workspace.service';
import { WORKSPACE_GRANTED_SCOPE_CTE } from './care-workspace-scope.repository';

export type WorkspaceTenant = { id: string; tenantCode: string; tenantName: string };

/** Current-context selection only, not private history or an occupancy projection.
 * EXISTS avoids duplicate tenants across multiple effective building contexts.
 * A building-only context suffices; there is deliberately no space/PIC join. */
async function readTenants(principal: CareWorkspacePrincipal, propertyId: string,
  afterId: string | null, limit: number, q: string | null, buildingId: string | null) {
  const result = await getPool().query<{
    authenticated: boolean; accessible: boolean; evaluatedAt: Date; items: WorkspaceTenant[];
  }>(`
    ${WORKSPACE_GRANTED_SCOPE_CTE}, selected_buildings AS (
      SELECT b.id, p.client_id FROM granted p
      JOIN buildings b ON b.property_id = p.id AND b.status = 'ACTIVE'
      WHERE ($8::uuid IS NULL OR b.id = $8)
    ), page AS (
      SELECT tc.id, tc.tenant_code AS "tenantCode", tc.tenant_name AS "tenantName"
      FROM tenant_companies tc
      WHERE tc.status = 'ACTIVE'
        AND ($5::uuid IS NULL OR tc.id > $5)
        AND ($7::text IS NULL OR strpos(lower(tc.tenant_code), lower($7)) > 0
          OR strpos(lower(tc.tenant_name), lower($7)) > 0)
        AND EXISTS (
          SELECT 1 FROM selected_buildings b
          JOIN tenant_building_contexts tbc ON tbc.building_id = b.id
          WHERE b.client_id = tc.client_id AND tbc.tenant_company_id = tc.id
            AND tbc.status = 'ACTIVE'
            AND (tbc.effective_from IS NULL OR tbc.effective_from <= statement_timestamp())
            AND (tbc.effective_until IS NULL OR tbc.effective_until >= statement_timestamp())
        )
      ORDER BY tc.id ASC LIMIT $6
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      (EXISTS(SELECT 1 FROM granted) AND
        ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM selected_buildings))) AS accessible,
      statement_timestamp() AS "evaluatedAt",
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM page), '[]'::jsonb) AS items`,
  [principal.sessionId, principal.careActorId, principal.integrationId, propertyId, afterId, limit + 1, q, buildingId]);
  return result.rows[0];
}

export const careWorkspaceTenantsRepository = { readTenants };
