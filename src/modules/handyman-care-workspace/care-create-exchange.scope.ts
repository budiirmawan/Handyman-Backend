import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { workspaceUnauthorized } from './care-workspace.service';

export const careCreateContextNotFound = () => new AppError({
  code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
  message: 'Care workspace resource not found.', statusCode: 404,
});

/** Additional binding for workspace-created credentials only. Existing handoff
 * context/representation services still own effective occupancy and grants.
 * Lock current identity/session and selected physical scope until tx commit. */
export async function lockCareCreateWorkspaceScope(tx: PoolClient, input: {
  sessionId: string; careActorId: string; integrationId: string;
  propertyId: string; tenantCompanyId: string; buildingId: string; spaceId: string | null;
}) {
  const identity = await tx.query<{ actorReference: string; integrationCode: string }>(`
    SELECT a.actor_reference AS "actorReference", i.integration_code AS "integrationCode"
    FROM handyman_care_workspace_sessions s
    JOIN handyman_handoff_care_actors a ON a.id = s.care_actor_id
    JOIN handyman_handoff_integrations i ON i.id = s.integration_id AND i.id = a.integration_id
    WHERE s.id = $1 AND a.id = $2 AND i.id = $3 AND a.status = 'ACTIVE'
      AND i.status = 'ACTIVE' AND i.actor_capability = 'CUSTOMER_CARE'
    FOR SHARE OF a, i`, [input.sessionId, input.careActorId, input.integrationId]);
  if (identity.rowCount !== 1) throw workspaceUnauthorized();
  // Authority -> session order matches workspace invalidation triggers.
  const session = await tx.query<{ expiresAt: Date }>(`
    SELECT expires_at AS "expiresAt" FROM handyman_care_workspace_sessions
    WHERE id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE`, [input.sessionId]);
  if (session.rowCount !== 1) throw workspaceUnauthorized();
  const context = await tx.query<{ clientId: string }>(`
    SELECT c.id AS "clientId" FROM buildings b
    JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
    JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
    JOIN tenant_companies tc ON tc.client_id = c.id AND tc.id = $3 AND tc.status = 'ACTIVE'
    WHERE b.id = $1 AND p.id = $2 AND b.status = 'ACTIVE'
    FOR SHARE OF b, p, c, tc`, [input.buildingId, input.propertyId, input.tenantCompanyId]);
  if (context.rowCount !== 1) throw careCreateContextNotFound();
  if (input.spaceId) {
    const hierarchy = await tx.query(`
      SELECT s.id FROM spaces s
      JOIN rooms r ON r.id = s.room_id AND r.status = 'ACTIVE'
      JOIN areas a ON a.id = r.area_id AND a.status = 'ACTIVE'
      JOIN floors f ON f.id = a.floor_id AND f.status = 'ACTIVE'
      WHERE s.id = $1 AND s.status = 'ACTIVE' AND f.building_id = $2
      FOR SHARE OF s, r, a, f`, [input.spaceId, input.buildingId]);
    if (hierarchy.rowCount !== 1) throw careCreateContextNotFound();
  }
  const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  if (session.rows[0].expiresAt <= clock.rows[0].now) throw workspaceUnauthorized();
  return { ...identity.rows[0], ...context.rows[0], expiresAt: session.rows[0].expiresAt };
}
