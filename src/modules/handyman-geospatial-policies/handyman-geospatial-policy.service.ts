import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { resolveHandymanExpectedArrivalLocation }
  from '../handyman-arrival-locations';
import {
  buildingGeospatialPolicyValidationError,
  geofenceSignalValidationError,
} from './handyman-geospatial-policy.errors';
import { handymanGeospatialPolicyRepository }
  from './handyman-geospatial-policy.repository';
import type {
  CreateHandymanBuildingGeospatialPolicyInput,
  EvaluateHandymanGeofenceSignalInput,
  HandymanBuildingGeospatialPolicyRecord,
  HandymanGeofenceSignalResult,
  PublicHandymanBuildingGeospatialPolicy,
} from './handyman-geospatial-policy.types';

/**
 * CR-HM-07 Arrival Verification PART 03B — per-Building geospatial
 * policy lifecycle + internal geofence SIGNAL (FROZEN decision
 * `CR-HM-07_GEOSPATIAL_AUTHORITY_DECISION.md` + PART 03A §3).
 *
 * Coordinate/radius/accuracy/freshness authority = operator-configured
 * per-Building policy (never device/QR/API.CO.ID/FM-derived).
 * Expected building = immutable Execution Scope snapshot (PART 02
 * resolver, read-only). Distance = deterministic server-side
 * haversine (pure, no external provider). Signals INSIDE/OUTSIDE/
 * LOW_ACCURACY/UNAVAILABLE are risk/corroboration ONLY — never an
 * arrival verdict. ZERO API.CO.ID, ZERO challenge consumption, ZERO
 * QR mutation, NO HTTP/OpenAPI, NO work-session/check-in/
 * attendance/payment/BAST/FM semantics.
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_GEOFENCE_INVALID_UUID:${field}`);
  }
  return raw;
}

function toPublic(
  record: HandymanBuildingGeospatialPolicyRecord,
): PublicHandymanBuildingGeospatialPolicy {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    referenceLatitude: record.referenceLatitude,
    referenceLongitude: record.referenceLongitude,
    geofenceRadiusMeters: record.geofenceRadiusMeters,
    maxAccuracyMeters: record.maxAccuracyMeters,
    maxLocationAgeSeconds: record.maxLocationAgeSeconds,
    status: record.status,
    effectiveFrom: record.effectiveFrom.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Audit-only journal; the policy table remains the authority. */
async function journal(
  tx: Pick<PoolClient, 'query'>,
  record: HandymanBuildingGeospatialPolicyRecord,
  eventType: string,
  summary: string,
  actorUserId: string,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: record.clientId,
      eventType,
      entityType: 'HANDYMAN_BUILDING_GEOSPATIAL_POLICY',
      entityId: record.id,
      actorUserId,
      summary,
      metadata: {
        policyId: record.id,
        buildingId: record.buildingId,
        status: record.status,
      },
    },
    tx,
  );
}

/**
 * Bounded physical sanity validation ONLY (decision §3–§6): no
 * business default/maximum exists anywhere.
 */
function validatePolicyValues(
  input: CreateHandymanBuildingGeospatialPolicyInput,
): { field: string; message: string }[] {
  const details: { field: string; message: string }[] = [];
  const lat = Number(input.referenceLatitude);
  const lng = Number(input.referenceLongitude);
  const radius = Number(input.geofenceRadiusMeters);
  const accuracy = Number(input.maxAccuracyMeters);
  const freshness = Number(input.maxLocationAgeSeconds);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    details.push({
      field: 'referenceLatitude',
      message: 'referenceLatitude must be a number within -90..90.',
    });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    details.push({
      field: 'referenceLongitude',
      message: 'referenceLongitude must be a number within -180..180.',
    });
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    details.push({
      field: 'geofenceRadiusMeters',
      message: 'geofenceRadiusMeters must be a positive number.',
    });
  }
  if (!Number.isFinite(accuracy) || accuracy <= 0) {
    details.push({
      field: 'maxAccuracyMeters',
      message: 'maxAccuracyMeters must be a positive number.',
    });
  }
  if (!Number.isInteger(freshness) || freshness <= 0) {
    details.push({
      field: 'maxLocationAgeSeconds',
      message: 'maxLocationAgeSeconds must be a positive integer.',
    });
  }
  if (input.effectiveFrom !== undefined && input.effectiveFrom !== null) {
    const ts = Date.parse(String(input.effectiveFrom));
    if (!Number.isFinite(ts)) {
      details.push({
        field: 'effectiveFrom',
        message: 'effectiveFrom must be a valid timestamp.',
      });
    }
  }
  return details;
}

/**
 * Create (first activation) or replace (history-preserving) the
 * per-Building geospatial policy. New policy is FULLY validated
 * before any mutation; replacement = old ACTIVE -> INACTIVE
 * (REPLACED journal) + new ACTIVE insert (CREATED journal), atomically
 * in ONE transaction. Historical rows are never overwritten/deleted.
 */
export async function saveHandymanBuildingGeospatialPolicy(
  input: CreateHandymanBuildingGeospatialPolicyInput,
  actorUserId: string,
): Promise<PublicHandymanBuildingGeospatialPolicy> {
  const buildingId = ensureUuid(input.buildingId, 'buildingId');
  ensureUuid(actorUserId, 'actorUserId');
  const details = validatePolicyValues(input);
  if (details.length > 0) {
    throw buildingGeospatialPolicyValidationError(details);
  }
  const building = await handymanGeospatialPolicyRepository
    .findBuildingAuthority(undefined, buildingId);
  if (!building || building.status !== 'ACTIVE') {
    throw buildingGeospatialPolicyValidationError([
      { field: 'buildingId', message: 'Building must exist and be ACTIVE.' },
    ]);
  }
  // CR-HM-SEC-02 PART 05 (PART 00A frozen decision D5) — the policy is
  // per-Building (`handyman_building_geospatial_policies.building_id`
  // NOT NULL, migration 0399) and the authoritative Building is already
  // resolved above, so the BE-02G exact-Building guard — not the
  // client-level `canAccessClient` shortcut — is the authoritative wall.
  // Ordering preserved: validation + building authority (400) →
  // exact-building authorization (403) → transaction (no mutation
  // before authorization).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: building.clientId,
    buildingId,
  });
  return withTransaction(async (tx) => {
    const existing = await handymanGeospatialPolicyRepository
      .lockActivePolicyByBuilding(tx, buildingId);
    // Replacement: retire the old ACTIVE row FIRST (AE index forbids
    // a transient duplicate), then insert the new ACTIVE row.
    if (existing) {
      const retired = await handymanGeospatialPolicyRepository
        .deactivatePolicy(tx, existing.id);
      if (!retired) {
        throw new Error('HANDYMAN_BLD_GEO_POLICY_REPLACE_CONFLICT');
      }
    }
    const record = await handymanGeospatialPolicyRepository
      .insertPolicy(tx, {
        clientId: building.clientId,
        buildingId,
        referenceLatitude: Number(input.referenceLatitude),
        referenceLongitude: Number(input.referenceLongitude),
        geofenceRadiusMeters: Number(input.geofenceRadiusMeters),
        maxAccuracyMeters: Number(input.maxAccuracyMeters),
        maxLocationAgeSeconds: Number(input.maxLocationAgeSeconds),
        effectiveFrom: input.effectiveFrom
          ? new Date(String(input.effectiveFrom))
          : null,
        createdByUserId: actorUserId,
      });
    if (existing) {
      await journal(
        tx,
        { ...existing, status: 'INACTIVE' },
        'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_REPLACED',
        `Handyman building geospatial policy replaced by ${record.id} (history preserved).`,
        actorUserId,
      );
    }
    await journal(
      tx,
      record,
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED',
      'Handyman building geospatial policy activated (operator-configured authority).',
      actorUserId,
    );
    return toPublic(record);
  });
}

/** Read the ACTIVE policy for a building (management/test paths). */
export async function getHandymanBuildingGeospatialPolicy(
  buildingId: string,
  actorUserId: string,
): Promise<PublicHandymanBuildingGeospatialPolicy | null> {
  ensureUuid(buildingId, 'buildingId');
  ensureUuid(actorUserId, 'actorUserId');
  const record = await handymanGeospatialPolicyRepository
    .findActivePolicyByBuilding(undefined, buildingId);
  if (!record) return null;
  // CR-HM-SEC-02 PART 05 (PART 00A frozen decision D5) — the loaded
  // policy's own clientId/buildingId are the authoritative scope; the
  // BE-02G exact-Building guard replaces the client-level shortcut.
  // Ordering preserved: a missing policy returns null (no existence
  // leak) BEFORE authorization.
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: record.clientId,
    buildingId: record.buildingId,
  });
  return toPublic(record);
}

/**
 * Deterministic geographic distance (haversine, WGS-84 mean radius
 * 6,371,000 m — a physical constant, not a policy value). Pure: same
 * inputs always produce the same meters. No external provider.
 */
export function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(latitudeB - latitudeA);
  const dLng = toRad(longitudeB - longitudeA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latitudeA)) *
      Math.cos(toRad(latitudeB)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Internal geofence SIGNAL evaluation (decision §7). Expected
 * building comes from the immutable Execution Scope snapshot ONLY
 * — never from device GPS/QR/caller. The ACTIVE policy for that
 * building is the radius/accuracy/freshness authority; evaluation
 * uses the server clock. Caller cannot author expected location,
 * reference coordinates, policy values, distance, insideGeofence, or
 * any signal/verdict (positional bounded input carries none).
 */
export async function evaluateHandymanBuildingGeofenceSignal(
  input: EvaluateHandymanGeofenceSignalInput,
  actorUserId: string,
): Promise<HandymanGeofenceSignalResult> {
  ensureUuid(input.executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');

  // Bounded device-signal validation (physical ranges + parseable
  // timestamp; no business policy invented).
  const details: { field: string; message: string }[] = [];
  const lat = Number(input.latitude);
  const lng = Number(input.longitude);
  const accuracy = Number(input.accuracyMeters);
  const capturedMs = Date.parse(String(input.capturedAt));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    details.push({
      field: 'latitude',
      message: 'latitude must be a number within -90..90.',
    });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    details.push({
      field: 'longitude',
      message: 'longitude must be a number within -180..180.',
    });
  }
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    details.push({
      field: 'accuracyMeters',
      message: 'accuracyMeters must be a number >= 0.',
    });
  }
  if (!Number.isFinite(capturedMs)) {
    details.push({
      field: 'capturedAt',
      message: 'capturedAt must be a valid timestamp.',
    });
  }
  if (details.length > 0) {
    throw geofenceSignalValidationError(details);
  }

  // Server clock remains the evaluation authority; an observation
  // objectively AFTER server evaluation time is invalid (no
  // clock-skew tolerance invented — strict past-or-now only).
  const evaluatedAtMs = Date.now();
  if (capturedMs > evaluatedAtMs) {
    throw geofenceSignalValidationError([
      {
        field: 'capturedAt',
        message: 'capturedAt must not be after server evaluation time.',
      },
    ]);
  }

  // Expected building: immutable Execution Scope snapshot authority.
  const expected = await resolveHandymanExpectedArrivalLocation(
    input.executionScopeId,
    actorUserId,
  );
  const policy = await handymanGeospatialPolicyRepository
    .findActivePolicyByBuilding(undefined, expected.buildingId);
  const evaluatedAt = new Date(evaluatedAtMs).toISOString();
  if (!policy) {
    return {
      signal: 'UNAVAILABLE',
      distanceMeters: null,
      policyId: null,
      evaluatedAt,
    };
  }
  // Freshness: observation age vs per-Building policy (decision §6).
  const ageSeconds = Math.floor((evaluatedAtMs - capturedMs) / 1000);
  if (ageSeconds > policy.maxLocationAgeSeconds) {
    return {
      signal: 'UNAVAILABLE',
      distanceMeters: null,
      policyId: policy.id,
      evaluatedAt,
    };
  }
  const distanceMeters = haversineDistanceMeters(
    lat,
    lng,
    policy.referenceLatitude,
    policy.referenceLongitude,
  );
  if (accuracy > policy.maxAccuracyMeters) {
    return {
      signal: 'LOW_ACCURACY',
      distanceMeters,
      policyId: policy.id,
      evaluatedAt,
    };
  }
  return {
    signal: distanceMeters <= policy.geofenceRadiusMeters
      ? 'INSIDE'
      : 'OUTSIDE',
    distanceMeters,
    policyId: policy.id,
    evaluatedAt,
  };
}

export const handymanGeospatialPolicyService = {
  saveHandymanBuildingGeospatialPolicy,
  getHandymanBuildingGeospatialPolicy,
  haversineDistanceMeters,
  evaluateHandymanBuildingGeofenceSignal,
};
