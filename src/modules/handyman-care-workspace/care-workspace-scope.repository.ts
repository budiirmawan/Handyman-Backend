import { getPool } from '../../database';
import type { CareWorkspacePrincipal } from './care-workspace.service';

export type WorkspaceProperty = { id: string; clientId: string; code: string; name: string };
export type WorkspaceBuilding = { id: string; propertyId: string; code: string; name: string };
export type ScopeResult = {
  authenticated: boolean;
  accessible: boolean;
  evaluatedAt: Date;
  items: (WorkspaceProperty | WorkspaceBuilding)[];
};

/** One statement snapshot: revalidate session + actor + integration alongside
 * grant/hierarchy filtering, before keyset pagination. No cached grant claims,
 * local User assignments, parallel master, or caller-supplied Client authority.
 * A property need not have buildings; its building collection may be empty. */
async function readScope(
  principal: CareWorkspacePrincipal,
  propertyId: string | null,
  afterId: string | null,
  limit: number,
): Promise<ScopeResult> {
  const building = propertyId !== null;
  const result = await getPool().query<ScopeResult>(`
    WITH authority AS (
      SELECT a.id AS actor_id
      FROM handyman_care_workspace_sessions s
      JOIN handyman_handoff_care_actors a ON a.id = s.care_actor_id
      JOIN handyman_handoff_integrations i ON i.id = s.integration_id AND i.id = a.integration_id
      WHERE s.id = $1 AND s.care_actor_id = $2 AND s.integration_id = $3
        AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
        AND a.status = 'ACTIVE' AND i.status = 'ACTIVE' AND i.actor_capability = 'CUSTOMER_CARE'
    ), granted AS (
      SELECT p.id, p.client_id, p.code, p.name
      FROM authority a
      JOIN handyman_care_property_grants g ON g.care_actor_id = a.actor_id AND g.status = 'ACTIVE'
      JOIN properties p ON p.id = g.property_id AND p.status = 'ACTIVE'
      JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      WHERE ($4::uuid IS NULL OR p.id = $4)
    ), page AS (
      ${building
        ? `SELECT b.id, b.property_id AS "propertyId", b.code, b.name
           FROM granted p JOIN buildings b ON b.property_id = p.id AND b.status = 'ACTIVE'
           WHERE ($5::uuid IS NULL OR b.id > $5) ORDER BY b.id ASC LIMIT $6`
        : `SELECT p.id, p.client_id AS "clientId", p.code, p.name FROM granted p
           WHERE ($5::uuid IS NULL OR p.id > $5) ORDER BY p.id ASC LIMIT $6`}
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM granted)) AS accessible,
      statement_timestamp() AS "evaluatedAt",
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM page), '[]'::jsonb) AS items`,
  [principal.sessionId, principal.careActorId, principal.integrationId, propertyId, afterId, limit + 1]);
  return result.rows[0];
}

export const careWorkspaceScopeRepository = { readScope };
