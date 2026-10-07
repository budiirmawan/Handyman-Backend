import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanBuildingGeospatialPolicyRecord,
  HandymanBuildingGeospatialPolicyStatus,
} from './handyman-geospatial-policy.types';

/**
 * CR-HM-07 PART 03B — geospatial policy repository. ONLY writer of
 * `handyman_building_geospatial_policies`: ACTIVE insert + the single
 * ACTIVE -> INACTIVE projection (history-preserving replacement).
 * Read-only building authority lookups stay here (masters consumed,
 * never mutated).
 */

type Row = QueryResultRow;

const POLICY_SELECT = `
  SELECT id, client_id, building_id, reference_latitude,
         reference_longitude, geofence_radius_meters,
         max_accuracy_meters, max_location_age_seconds, status,
         effective_from, created_by_user_id, created_at, updated_at
    FROM handyman_building_geospatial_policies`;

function map(row: Row): HandymanBuildingGeospatialPolicyRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    referenceLatitude: Number(row.reference_latitude),
    referenceLongitude: Number(row.reference_longitude),
    geofenceRadiusMeters: Number(row.geofence_radius_meters),
    maxAccuracyMeters: Number(row.max_accuracy_meters),
    maxLocationAgeSeconds: Number(row.max_location_age_seconds),
    status: row.status as HandymanBuildingGeospatialPolicyStatus,
    effectiveFrom: row.effective_from,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Building read incl. its property Client (policy authority). */
async function findBuildingAuthority(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<{ id: string; clientId: string; status: string } | null> {
  const result = await executor.query(
    `SELECT b.id, p.client_id, b.status
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, clientId: row.client_id, status: row.status }
    : null;
}

/** ACTIVE policy for a building (read path). */
async function findActivePolicyByBuilding(
  executor: Pick<PoolClient, 'query'> = getPool(),
  buildingId: string,
): Promise<HandymanBuildingGeospatialPolicyRecord | null> {
  const result = await executor.query(
    `${POLICY_SELECT}
      WHERE building_id = $1 AND status = 'ACTIVE'`,
    [buildingId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** ACTIVE policy for a building, locked (replacement boundary). */
async function lockActivePolicyByBuilding(
  executor: Pick<PoolClient, 'query'>,
  buildingId: string,
): Promise<HandymanBuildingGeospatialPolicyRecord | null> {
  const result = await executor.query(
    `${POLICY_SELECT}
      WHERE building_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [buildingId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Insert ACTIVE policy (validated + client-derived by service). */
async function insertPolicy(
  executor: Pick<PoolClient, 'query'>,
  record: Omit<
    HandymanBuildingGeospatialPolicyRecord,
    'id' | 'status' | 'effectiveFrom' | 'createdAt' | 'updatedAt'
  > & { effectiveFrom: Date | null },
): Promise<HandymanBuildingGeospatialPolicyRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_building_geospatial_policies (
       id, client_id, building_id, reference_latitude,
       reference_longitude, geofence_radius_meters,
       max_accuracy_meters, max_location_age_seconds, status,
       effective_from, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE',
               COALESCE($9, NOW()), $10)
     RETURNING id, client_id, building_id, reference_latitude,
               reference_longitude, geofence_radius_meters,
               max_accuracy_meters, max_location_age_seconds, status,
               effective_from, created_by_user_id, created_at,
               updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.buildingId,
      record.referenceLatitude,
      record.referenceLongitude,
      record.geofenceRadiusMeters,
      record.maxAccuracyMeters,
      record.maxLocationAgeSeconds,
      record.effectiveFrom,
      record.createdByUserId,
    ],
  );
  return map(result.rows[0]);
}

/** The single permitted history-preserving projection. */
async function deactivatePolicy(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanBuildingGeospatialPolicyRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_building_geospatial_policies
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id, client_id, building_id, reference_latitude,
               reference_longitude, geofence_radius_meters,
               max_accuracy_meters, max_location_age_seconds, status,
               effective_from, created_by_user_id, created_at,
               updated_at`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanGeospatialPolicyRepository = {
  findBuildingAuthority,
  findActivePolicyByBuilding,
  lockActivePolicyByBuilding,
  insertPolicy,
  deactivatePolicy,
};
