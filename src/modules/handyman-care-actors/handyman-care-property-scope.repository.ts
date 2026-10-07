import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';

export type CarePropertyGrantRecord = {
  id: string;
  careActorId: string;
  propertyId: string;
  status: 'ACTIVE' | 'REVOKED';
  grantedByUserId: string;
  grantedAt: Date;
  revokedByUserId: string | null;
  revokedAt: Date | null;
};

const SELECT = `g.id, g.care_actor_id AS "careActorId",
  g.property_id AS "propertyId", g.status,
  g.granted_by_user_id AS "grantedByUserId", g.granted_at AS "grantedAt",
  g.revoked_by_user_id AS "revokedByUserId", g.revoked_at AS "revokedAt"`;

async function findActive(
  tx: Pick<PoolClient, 'query'>,
  careActorId: string,
  propertyId: string,
): Promise<CarePropertyGrantRecord | null> {
  const result = await tx.query<CarePropertyGrantRecord>(
    `SELECT ${SELECT} FROM handyman_care_property_grants g
      WHERE g.care_actor_id = $1 AND g.property_id = $2 AND g.status = 'ACTIVE'`,
    [careActorId, propertyId],
  );
  return result.rows[0] ?? null;
}

async function insert(
  tx: Pick<PoolClient, 'query'>,
  input: { careActorId: string; propertyId: string; grantedByUserId: string },
): Promise<CarePropertyGrantRecord> {
  const result = await tx.query<CarePropertyGrantRecord>(
    `INSERT INTO handyman_care_property_grants
       (id, care_actor_id, property_id, granted_by_user_id)
     VALUES ($1, $2, $3, $4) RETURNING
       id, care_actor_id AS "careActorId", property_id AS "propertyId", status,
       granted_by_user_id AS "grantedByUserId", granted_at AS "grantedAt",
       revoked_by_user_id AS "revokedByUserId", revoked_at AS "revokedAt"`,
    [randomUUID(), input.careActorId, input.propertyId, input.grantedByUserId],
  );
  return result.rows[0];
}

async function revoke(
  tx: Pick<PoolClient, 'query'>,
  careActorId: string,
  propertyId: string,
  revokedByUserId: string,
): Promise<CarePropertyGrantRecord | null> {
  const result = await tx.query<CarePropertyGrantRecord>(
    `UPDATE handyman_care_property_grants g
        SET status = 'REVOKED', revoked_by_user_id = $3, revoked_at = NOW()
      WHERE care_actor_id = $1 AND property_id = $2 AND status = 'ACTIVE'
      RETURNING ${SELECT}`,
    [careActorId, propertyId, revokedByUserId],
  );
  return result.rows[0] ?? null;
}

/** All status, hierarchy and Client checks happen in the database query.
 * Caller must supply the represented Client from trusted context; passing a
 * Client id does not create authority. No scope exists without every join. */
async function resolveActiveForBuilding(
  careActorId: string,
  buildingId: string,
  clientId: string,
): Promise<CarePropertyGrantRecord | null> {
  const result = await getPool().query<CarePropertyGrantRecord>(
    `SELECT ${SELECT} FROM handyman_care_property_grants g
      JOIN handyman_handoff_care_actors a ON a.id = g.care_actor_id
      JOIN handyman_handoff_integrations i ON i.id = a.integration_id
      JOIN properties p ON p.id = g.property_id
      JOIN buildings b ON b.property_id = p.id
      JOIN clients c ON c.id = p.client_id
      WHERE g.care_actor_id = $1 AND b.id = $2 AND c.id = $3
        AND g.status = 'ACTIVE' AND a.status = 'ACTIVE'
        AND i.status = 'ACTIVE' AND i.actor_capability = 'CUSTOMER_CARE'
        AND p.status = 'ACTIVE' AND b.status = 'ACTIVE' AND c.status = 'ACTIVE'`,
    [careActorId, buildingId, clientId],
  );
  return result.rows[0] ?? null;
}

export const handymanCarePropertyScopeRepository = {
  findActive,
  insert,
  revoke,
  resolveActiveForBuilding,
};
