import { getPool } from '../../database';
import type { CareWorkspacePrincipal } from './care-workspace.service';
import { WORKSPACE_GRANTED_SCOPE_CTE } from './care-workspace-scope.repository';

/** id is the existing spaces.id (spaceId), never a new Unit identity. */
export type WorkspaceSpace = { id: string; code: string; name: string; roomId: string; buildingId: string };

/** Physical discovery only. No tenant/PIC/occupancy join or inference. Session,
 * grant and every hierarchy ancestor are evaluated in the projection statement. */
async function readSpaces(principal: CareWorkspacePrincipal, propertyId: string,
  afterId: string | null, limit: number, q: string | null, buildingId: string | null) {
  const result = await getPool().query<{
    authenticated: boolean; accessible: boolean; evaluatedAt: Date; items: WorkspaceSpace[];
  }>(`
    ${WORKSPACE_GRANTED_SCOPE_CTE}, selected_buildings AS (
      SELECT b.id FROM granted p
      JOIN buildings b ON b.property_id = p.id AND b.status = 'ACTIVE'
      WHERE ($8::uuid IS NULL OR b.id = $8)
    ), page AS (
      SELECT s.id, s.code, s.name, s.room_id AS "roomId", b.id AS "buildingId"
      FROM selected_buildings b
      JOIN floors f ON f.building_id = b.id AND f.status = 'ACTIVE'
      JOIN areas a ON a.floor_id = f.id AND a.status = 'ACTIVE'
      JOIN rooms r ON r.area_id = a.id AND r.status = 'ACTIVE'
      JOIN spaces s ON s.room_id = r.id AND s.status = 'ACTIVE'
      WHERE ($5::uuid IS NULL OR s.id > $5)
        AND ($7::text IS NULL OR strpos(lower(s.code), lower($7)) > 0
          OR strpos(lower(s.name), lower($7)) > 0)
      ORDER BY s.id ASC LIMIT $6
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      (EXISTS(SELECT 1 FROM granted) AND
        ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM selected_buildings))) AS accessible,
      statement_timestamp() AS "evaluatedAt",
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM page), '[]'::jsonb) AS items`,
  [principal.sessionId, principal.careActorId, principal.integrationId, propertyId, afterId, limit + 1, q, buildingId]);
  return result.rows[0];
}

export const careWorkspaceSpacesRepository = { readSpaces };
