import { getPool } from '../../database';
import type { CareWorkspacePrincipal } from './care-workspace.service';
import { WORKSPACE_GRANTED_SCOPE_CTE } from './care-workspace-scope.repository';

export type WorkspaceOccupancy = {
  /** Internal kind:relationship-id keyset only; omitted from the public projection. */
  id: string;
  kind: 'BUILDING' | 'SPACE';
  clientId: string;
  propertyId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  tenantBuildingContextId: string;
  tenantSpaceRelationshipId: string | null;
  tenantBuildingEffectiveFrom: string | null;
  tenantBuildingEffectiveUntil: string | null;
  tenantSpaceEffectiveFrom: string | null;
  tenantSpaceEffectiveUntil: string | null;
};

/** No new occupancy persistence or snapshot permission. Both relationship
 * authorities, tenant and physical hierarchy are composed at statement time.
 * BUILDING rows do not require or invent a space relationship. */
async function readOccupancies(principal: CareWorkspacePrincipal, propertyId: string,
  afterId: string | null, limit: number, tenantCompanyId: string | null,
  buildingId: string | null, spaceId: string | null) {
  const result = await getPool().query<{
    authenticated: boolean; accessible: boolean; evaluatedAt: Date;
    revision: string; items: WorkspaceOccupancy[];
  }>(`
    ${WORKSPACE_GRANTED_SCOPE_CTE}, context_base AS (
      SELECT p.client_id, p.id AS property_id, tc.id AS tenant_company_id,
        b.id AS building_id, tbc.id AS context_id,
        tbc.effective_from AS building_from, tbc.effective_until AS building_until
      FROM granted p
      JOIN buildings b ON b.property_id = p.id AND b.status = 'ACTIVE'
      JOIN tenant_building_contexts tbc ON tbc.building_id = b.id AND tbc.status = 'ACTIVE'
      JOIN tenant_companies tc ON tc.id = tbc.tenant_company_id
        AND tc.client_id = p.client_id AND tc.status = 'ACTIVE'
      WHERE ($7::uuid IS NULL OR tc.id = $7) AND ($8::uuid IS NULL OR b.id = $8)
        AND (tbc.effective_from IS NULL OR tbc.effective_from <= statement_timestamp())
        AND (tbc.effective_until IS NULL OR tbc.effective_until >= statement_timestamp())
    ), records AS (
      SELECT 'BUILDING:' || c.context_id::text AS id, 'BUILDING' AS kind,
        c.client_id AS "clientId", c.property_id AS "propertyId",
        c.tenant_company_id AS "tenantCompanyId", c.building_id AS "buildingId",
        NULL::uuid AS "spaceId", c.context_id AS "tenantBuildingContextId",
        NULL::uuid AS "tenantSpaceRelationshipId",
        c.building_from AS "tenantBuildingEffectiveFrom", c.building_until AS "tenantBuildingEffectiveUntil",
        NULL::timestamptz AS "tenantSpaceEffectiveFrom", NULL::timestamptz AS "tenantSpaceEffectiveUntil"
      FROM context_base c WHERE $9::uuid IS NULL
      UNION ALL
      SELECT 'SPACE:' || tsr.id::text AS id, 'SPACE' AS kind,
        c.client_id, c.property_id, c.tenant_company_id, c.building_id,
        s.id, c.context_id, tsr.id, c.building_from, c.building_until,
        tsr.effective_from, tsr.effective_until
      FROM context_base c
      JOIN tenant_space_relationships tsr ON tsr.tenant_company_id = c.tenant_company_id
        AND tsr.building_id = c.building_id AND tsr.status = 'ACTIVE'
      JOIN spaces s ON s.id = tsr.space_id AND s.status = 'ACTIVE'
      JOIN rooms r ON r.id = s.room_id AND r.status = 'ACTIVE'
      JOIN areas a ON a.id = r.area_id AND a.status = 'ACTIVE'
      JOIN floors f ON f.id = a.floor_id AND f.status = 'ACTIVE' AND f.building_id = c.building_id
      WHERE ($9::uuid IS NULL OR s.id = $9)
        AND (tsr.effective_from IS NULL OR tsr.effective_from <= statement_timestamp())
        AND (tsr.effective_until IS NULL OR tsr.effective_until >= statement_timestamp())
    ), page AS (
      SELECT * FROM records WHERE ($5::text IS NULL OR id COLLATE "C" > $5 COLLATE "C")
      ORDER BY id COLLATE "C" ASC LIMIT $6
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      EXISTS(SELECT 1 FROM records) AS accessible,
      statement_timestamp() AS "evaluatedAt",
      -- A change marker, not authority: reject continuation on turnover or
      -- effective-window/hierarchy changes, even for a space-only selection.
      -- Does not include evaluatedAt, which changes on every page.
      (SELECT encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(records)::text,
        '' ORDER BY id COLLATE "C"), ''), 'UTF8')), 'hex') FROM records) AS revision,
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id COLLATE "C") FROM page), '[]'::jsonb) AS items`,
  [principal.sessionId, principal.careActorId, principal.integrationId, propertyId,
    afterId, limit + 1, tenantCompanyId, buildingId, spaceId]);
  return result.rows[0];
}

export const careWorkspaceOccupanciesRepository = { readOccupancies };
