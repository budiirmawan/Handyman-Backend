import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  AssetFailureCompositeRecord,
  AssetFailureFilters,
  AssetFailureRecord,
  AssetFailureStatus,
  NewAssetFailure,
  UpdateAssetFailureInput,
} from './asset-failure.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * Foundation columns are always READ from `incidents`, and Asset columns from
 * `assets` — neither is duplicated into `asset_failure_incidents`. This JOIN
 * is the composition, so BE-21A remains the single source of truth for
 * Incident identity/context/lifecycle and BE-05 for Asset master data.
 *
 * Because `assetStatus` is projected live rather than copied, a failure record
 * can never show a stale Asset lifecycle state.
 */
const SELECT = `
  af.id,
  af.incident_id AS "incidentId",
  af.asset_id AS "assetId",
  af.failure_category AS "failureCategory",
  af.occurred_at AS "occurredAt",
  af.operational_impact AS "operationalImpact",
  af.failure_status AS "failureStatus",
  af.status_changed_at AS "statusChangedAt",
  af.notes,
  af.created_by_user_id AS "createdByUserId",
  af.created_at AS "createdAt",
  af.updated_at AS "updatedAt",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.title,
  i.description,
  i.severity,
  i.priority,
  i.status AS "incidentStatus",
  i.location_type AS "locationType",
  i.floor_id AS "floorId",
  i.area_id AS "areaId",
  i.room_id AS "roomId",
  i.space_id AS "spaceId",
  i.functional_location_id AS "functionalLocationId",
  i.reported_by_user_id AS "reportedByUserId",
  i.reported_at AS "reportedAt",
  a.client_id AS "assetClientId",
  a.building_id AS "assetBuildingId",
  a.asset_code AS "assetCode",
  a.asset_name AS "assetName",
  a.status AS "assetStatus",
  a.functional_location_id AS "assetFunctionalLocationId"
`;

const FROM = `
  FROM asset_failure_incidents af
  JOIN incidents i ON i.id = af.incident_id
  JOIN assets a ON a.id = af.asset_id
`;

async function create(
  input: NewAssetFailure,
  executor: Executor = getPool(),
): Promise<AssetFailureRecord> {
  const result = await executor.query<AssetFailureRecord>(
    `INSERT INTO asset_failure_incidents
       (id, incident_id, asset_id, failure_category, occurred_at,
        operational_impact, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING
       id,
       incident_id AS "incidentId",
       asset_id AS "assetId",
       failure_category AS "failureCategory",
       occurred_at AS "occurredAt",
       operational_impact AS "operationalImpact",
       failure_status AS "failureStatus",
       status_changed_at AS "statusChangedAt",
       notes,
       created_by_user_id AS "createdByUserId",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      randomUUID(),
      input.incidentId,
      input.assetId,
      input.failureCategory,
      input.occurredAt,
      input.operationalImpact,
      input.notes,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/** Addressed by the SHARED BE-21A Incident id, not the specialization id. */
async function findByIncidentId(
  incidentId: string,
): Promise<AssetFailureCompositeRecord | null> {
  const result = await getPool().query<AssetFailureCompositeRecord>(
    `SELECT ${SELECT} ${FROM} WHERE af.incident_id = $1`,
    [incidentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL,
 * so an out-of-scope Asset Failure is never loaded into memory.
 */
async function list(
  filters: AssetFailureFilters,
  accessibleBuildingIds: string[],
): Promise<AssetFailureCompositeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.assetId) {
    values.push(filters.assetId);
    conditions.push(`af.asset_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.locationType) {
    values.push(filters.locationType);
    conditions.push(`i.location_type = $${values.length}`);
  }
  if (filters.locationId) {
    values.push(filters.locationId);
    conditions.push(`$${values.length} IN (
      i.floor_id, i.area_id, i.room_id, i.space_id, i.functional_location_id
    )`);
  }
  if (filters.failureCategory) {
    values.push(filters.failureCategory);
    conditions.push(`af.failure_category = $${values.length}`);
  }
  if (filters.operationalImpact) {
    values.push(filters.operationalImpact);
    conditions.push(`af.operational_impact = $${values.length}`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    conditions.push(`i.severity = $${values.length}`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    conditions.push(`i.priority = $${values.length}`);
  }
  if (filters.failureStatus) {
    values.push(filters.failureStatus);
    conditions.push(`af.failure_status = $${values.length}`);
  }
  if (filters.incidentStatus) {
    values.push(filters.incidentStatus);
    conditions.push(`i.status = $${values.length}`);
  }
  if (filters.occurredFrom) {
    values.push(filters.occurredFrom);
    conditions.push(`af.occurred_at >= $${values.length}`);
  }
  if (filters.occurredTo) {
    values.push(filters.occurredTo);
    conditions.push(`af.occurred_at <= $${values.length}`);
  }

  const result = await getPool().query<AssetFailureCompositeRecord>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY af.occurred_at DESC, af.id DESC`,
    values,
  );
  return result.rows;
}

/**
 * Updates only the BE-21C failure columns. `asset_id` is intentionally not
 * updatable — see `UpdateAssetFailureInput`.
 */
async function update(
  incidentId: string,
  input: Pick<
    UpdateAssetFailureInput,
    'failureCategory' | 'occurredAt' | 'operationalImpact' | 'notes'
  >,
  executor: Executor = getPool(),
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.failureCategory !== undefined) {
    values.push(input.failureCategory);
    assignments.push(`failure_category = $${values.length}`);
  }
  if (input.occurredAt !== undefined) {
    values.push(input.occurredAt);
    assignments.push(`occurred_at = $${values.length}`);
  }
  if (input.operationalImpact !== undefined) {
    values.push(input.operationalImpact);
    assignments.push(`operational_impact = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    assignments.push(`notes = $${values.length}`);
  }
  if (assignments.length === 0) return;

  values.push(incidentId);
  await executor.query(
    `UPDATE asset_failure_incidents
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE incident_id = $${values.length}`,
    values,
  );
}

/**
 * Guarded transition: the WHERE clause pins the expected current status, so a
 * concurrent transition cannot be silently overwritten.
 */
async function transitionStatus(
  incidentId: string,
  from: AssetFailureStatus,
  to: AssetFailureStatus,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE asset_failure_incidents
     SET failure_status = $3,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE incident_id = $1 AND failure_status = $2`,
    [incidentId, from, to],
  );
  return (result.rowCount ?? 0) > 0;
}

export const assetFailureRepository = {
  create,
  findByIncidentId,
  list,
  transitionStatus,
  update,
};
