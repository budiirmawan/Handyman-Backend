import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { arrivalResultConflictError }
  from './handyman-arrival-result.errors';
import type {
  HandymanArrivalVerificationResultRecord,
  NewHandymanArrivalVerificationResult,
} from './handyman-arrival-result.types';

/**
 * CR-HM-07 PART 04A — persistence helper for terminal arrival results:
 * insert immutable result + get result by challengeId ONLY. NO
 * decision logic, NO consumption, NO signal evaluation (PART 04B+).
 */

type QueryExecutor = Pick<PoolClient, 'query'>;

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function dateOrNull(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

function map(row: Record<string, unknown>):
HandymanArrivalVerificationResultRecord {
  return {
    id: row.id as string,
    clientId: row.client_id as string,
    executionScopeId: row.execution_scope_id as string,
    assignmentId: row.assignment_id as string,
    actorUserId: row.actor_user_id as string,
    challengeId: row.challenge_id as string,
    expectedBuildingId: row.expected_building_id as string,
    expectedFloorId: (row.expected_floor_id as string | null) ?? null,
    expectedAreaId: (row.expected_area_id as string | null) ?? null,
    expectedRoomId: (row.expected_room_id as string | null) ?? null,
    expectedSpaceId: (row.expected_space_id as string | null) ?? null,
    qrSignal: row.qr_signal as string,
    deviceLatitude: num(row.device_latitude),
    deviceLongitude: num(row.device_longitude),
    deviceAccuracyMeters: num(row.device_accuracy_meters),
    deviceCapturedAt: dateOrNull(row.device_captured_at),
    geofenceSignal:
      row.geofence_signal as HandymanArrivalVerificationResultRecord[
        'geofenceSignal'
      ],
    distanceMeters: num(row.distance_meters),
    geospatialPolicyId: (row.geospatial_policy_id as string | null) ?? null,
    reverseGeocodeStatus:
      row.reverse_geocode_status as HandymanArrivalVerificationResultRecord[
        'reverseGeocodeStatus'
      ],
    reverseGeocodeDisplayName:
      (row.reverse_geocode_display_name as string | null) ?? null,
    reverseGeocodeProvince:
      (row.reverse_geocode_province as string | null) ?? null,
    reverseGeocodeRegency:
      (row.reverse_geocode_regency as string | null) ?? null,
    reverseGeocodeDistrict:
      (row.reverse_geocode_district as string | null) ?? null,
    reverseGeocodeVillage:
      (row.reverse_geocode_village as string | null) ?? null,
    reverseGeocodePostalCode:
      (row.reverse_geocode_postal_code as string | null) ?? null,
    reverseGeocodeProviderPlaceId:
      (row.reverse_geocode_provider_place_id as string | null) ?? null,
    status: row.status as HandymanArrivalVerificationResultRecord['status'],
    primaryReason: row.primary_reason as string,
    evaluatedAt: row.evaluated_at as Date,
    createdAt: row.created_at as Date,
  };
}

const COLUMNS = `
  id, client_id, execution_scope_id, assignment_id, actor_user_id,
  challenge_id, expected_building_id, expected_floor_id,
  expected_area_id, expected_room_id, expected_space_id, qr_signal,
  device_latitude, device_longitude, device_accuracy_meters,
  device_captured_at, geofence_signal, distance_meters,
  geospatial_policy_id, reverse_geocode_status,
  reverse_geocode_display_name, reverse_geocode_province,
  reverse_geocode_regency, reverse_geocode_district,
  reverse_geocode_village, reverse_geocode_postal_code,
  reverse_geocode_provider_place_id, status, primary_reason,
  evaluated_at, created_at
`;

/**
 * Inserts the immutable terminal result. `23505` on the
 * one-result-per-challenge unique index maps to the bounded conflict
 * (governance §15: replay must look up the EXISTING result instead).
 */
export async function insertHandymanArrivalVerificationResult(
  input: NewHandymanArrivalVerificationResult,
  executor: QueryExecutor = getPool(),
): Promise<HandymanArrivalVerificationResultRecord> {
  try {
    const result = await executor.query(
      `INSERT INTO handyman_arrival_verification_results (
        id, client_id, execution_scope_id, assignment_id, actor_user_id,
        challenge_id, expected_building_id, expected_floor_id,
        expected_area_id, expected_room_id, expected_space_id, qr_signal,
        device_latitude, device_longitude, device_accuracy_meters,
        device_captured_at, geofence_signal, distance_meters,
        geospatial_policy_id, reverse_geocode_status,
        reverse_geocode_display_name, reverse_geocode_province,
        reverse_geocode_regency, reverse_geocode_district,
        reverse_geocode_village, reverse_geocode_postal_code,
        reverse_geocode_provider_place_id, status, primary_reason,
        evaluated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
              $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
      RETURNING ${COLUMNS}`,
      [
        input.id ?? randomUUID(),
        input.clientId,
        input.executionScopeId,
        input.assignmentId,
        input.actorUserId,
        input.challengeId,
        input.expectedBuildingId,
        input.expectedFloorId,
        input.expectedAreaId,
        input.expectedRoomId,
        input.expectedSpaceId,
        input.qrSignal,
        input.deviceLatitude,
        input.deviceLongitude,
        input.deviceAccuracyMeters,
        input.deviceCapturedAt,
        input.geofenceSignal,
        input.distanceMeters,
        input.geospatialPolicyId,
        input.reverseGeocodeStatus,
        input.reverseGeocodeDisplayName,
        input.reverseGeocodeProvince,
        input.reverseGeocodeRegency,
        input.reverseGeocodeDistrict,
        input.reverseGeocodeVillage,
        input.reverseGeocodePostalCode,
        input.reverseGeocodeProviderPlaceId,
        input.status,
        input.primaryReason,
        input.evaluatedAt,
      ],
    );
    return map(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw arrivalResultConflictError(input.challengeId);
    }
    throw error;
  }
}

/** Retrieves the terminal result bound to a challenge (or null). */
export async function findHandymanArrivalResultByChallengeId(
  executor: QueryExecutor,
  challengeId: string,
): Promise<HandymanArrivalVerificationResultRecord | null>;
export async function findHandymanArrivalResultByChallengeId(
  challengeId: string,
): Promise<HandymanArrivalVerificationResultRecord | null>;
export async function findHandymanArrivalResultByChallengeId(
  arg1: QueryExecutor | string,
  arg2?: string,
): Promise<HandymanArrivalVerificationResultRecord | null> {
  const executor = typeof arg1 === 'string' ? getPool() : arg1;
  const challengeId = typeof arg1 === 'string' ? arg1 : arg2;
  if (typeof challengeId !== 'string') {
    throw new Error('HANDYMAN_ARRIVAL_RESULT_INVALID_CHALLENGE_ID');
  }
  const result = await executor.query(
    `SELECT ${COLUMNS} FROM handyman_arrival_verification_results
      WHERE challenge_id = $1`,
    [challengeId],
  );
  return result.rowCount === 0 ? null : map(result.rows[0]);
}

/**
 * CR-HM-17 GAP PART 03 — lists all immutable terminal arrival verification
 * results recorded for an execution scope in chronological order.
 */
export async function listHandymanArrivalResultsByExecutionScope(
  executor: QueryExecutor = getPool(),
  executionScopeId: string,
): Promise<HandymanArrivalVerificationResultRecord[]> {
  const result = await executor.query(
    `SELECT ${COLUMNS}
       FROM handyman_arrival_verification_results
      WHERE execution_scope_id = $1
      ORDER BY evaluated_at ASC, created_at ASC, id ASC`,
    [executionScopeId],
  );
  return result.rows.map(map);
}

export const handymanArrivalResultRepository = {
  insertHandymanArrivalVerificationResult,
  findHandymanArrivalResultByChallengeId,
  listHandymanArrivalResultsByExecutionScope,
};
