// Server-internal reads of the EXISTING configuration foundations (their
// module indexes export only the RBAC-gated service surfaces; arrival
// verification must stay backend-authoritative and never require the field
// actor to hold building_configuration permissions).
import { buildingConfigurationRepository } from '../building-configurations/building-configuration.repository';
import { configurationVersionRepository } from '../configuration-versions/configuration-version.repository';
import type {
  HandymanVisitArrivalFailureReason,
  HandymanVisitArrivalMethod,
} from './handyman-visit-arrival.types';
import { HANDYMAN_VISIT_ARRIVAL_METHODS } from './handyman-visit-arrival.types';

/**
 * CR-HM-BE-06 RUN 1 — arrival verification policy reader + the server-only
 * GPS decision.
 *
 * Governance (binding):
 * - The policy REUSES the existing building configuration authority: a
 *   Handyman-owned key on BE-27B `building_configurations`, versioned and
 *   activated through the BE-27N/O `configuration-versions` lifecycle
 *   (BUILDING_CONFIGURATION source type). NO Handyman configuration table,
 *   NO buildings/functional_locations mutation.
 * - Backend-authoritative + fail-closed: absent row, INACTIVE row, no
 *   ACTIVE lifecycle version (including a versioned-but-unactivated row),
 *   or a schema-invalid snapshot all mean GPS verification is UNAVAILABLE —
 *   there is NO magic/default radius and NO default policy point.
 * - The client never supplies a radius, a policy point, or a decision: raw
 *   claim coordinates are evidence input only; this module computes the
 *   deterministic server-side distance and owns the VERIFIED/FAILED result.
 * - ASSISTED arrival is the governed override for exactly these fail-closed
 *   states, so `allowedMethods` gates the GPS path only — an ASSISTED
 *   arrival is never blocked by a missing/disabled policy (that would lock
 *   crews out of arrival entirely).
 */

/** Handyman-owned key in the existing building configuration authority. */
export const HANDYMAN_ARRIVAL_VERIFICATION_CONFIGURATION_KEY =
  'HANDYMAN.ARRIVALVERIFICATION';

/** Required policy shape (exact; extra fields are ignored, missing or
 * mistyped fields are fail-closed INVALID). */
export type HandymanArrivalVerificationPolicy = {
  enabled: boolean;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  allowedMethods: HandymanVisitArrivalMethod[];
};

export type ArrivalPolicyResolution =
  | {
      status: 'UNAVAILABLE';
      /** The consulted row id when one exists (still fail-closed). */
      buildingConfigurationId: string | null;
      configurationVersionId: null;
    }
  | {
      status: 'INVALID';
      buildingConfigurationId: string;
      configurationVersionId: string;
    }
  | {
      status: 'DISABLED';
      buildingConfigurationId: string;
      configurationVersionId: string;
    }
  | {
      status: 'METHOD_NOT_ALLOWED';
      buildingConfigurationId: string;
      configurationVersionId: string;
    }
  | {
      status: 'READY';
      policy: HandymanArrivalVerificationPolicy;
      /** Exact provenance recorded on the arrival attempt. */
      buildingConfigurationId: string;
      configurationVersionId: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Strict, fail-closed schema validation of one policy snapshot. Returns
 * null for ANY deviation — an invalid policy is never partially applied and
 * never falls back to a default.
 */
export function parseArrivalVerificationPolicy(
  snapshot: unknown,
): HandymanArrivalVerificationPolicy | null {
  if (!isRecord(snapshot)) return null;
  const { enabled, latitude, longitude, radiusMeters, allowedMethods } =
    snapshot;
  if (typeof enabled !== 'boolean') return null;
  if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) return null;
  if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
    return null;
  }
  // NO magic/default radius: a policy without a positive finite radius is
  // invalid, full stop.
  if (!isFiniteNumber(radiusMeters) || radiusMeters <= 0) return null;
  if (!Array.isArray(allowedMethods) || allowedMethods.length === 0) {
    return null;
  }
  for (const method of allowedMethods) {
    if (
      typeof method !== 'string' ||
      !(HANDYMAN_VISIT_ARRIVAL_METHODS as readonly string[]).includes(method)
    ) {
      return null;
    }
  }
  return {
    enabled,
    latitude,
    longitude,
    radiusMeters,
    allowedMethods: allowedMethods as HandymanVisitArrivalMethod[],
  };
}

/**
 * Resolves the ACTIVE authoritative arrival policy for a building with its
 * exact version provenance. Fail-closed on every branch:
 * - no configuration row, or the row is not ACTIVE → UNAVAILABLE;
 * - the row has no ACTIVE BE-27N/O lifecycle version (never versioned, or
 *   versioned but still DRAFT/VALIDATED/PUBLISHED, or all SUPERSEDED) →
 *   UNAVAILABLE — governed writes always capture versions, so an activated
 *   version is the provenance contract of this policy;
 * - the ACTIVE snapshot fails schema validation → INVALID.
 */
export async function resolveArrivalVerificationPolicy(
  buildingId: string,
): Promise<ArrivalPolicyResolution> {
  const record = await buildingConfigurationRepository.findByBuildingAndKey(
    buildingId,
    HANDYMAN_ARRIVAL_VERIFICATION_CONFIGURATION_KEY,
  );
  if (!record) {
    return {
      status: 'UNAVAILABLE',
      buildingConfigurationId: null,
      configurationVersionId: null,
    };
  }
  if (record.status !== 'ACTIVE') {
    return {
      status: 'UNAVAILABLE',
      buildingConfigurationId: record.id,
      configurationVersionId: null,
    };
  }
  const versions = await configurationVersionRepository.listBySource(
    'BUILDING_CONFIGURATION',
    record.id,
  );
  const active = versions.find(
    (version) => version.lifecycleStatus === 'ACTIVE',
  );
  if (!active) {
    return {
      status: 'UNAVAILABLE',
      buildingConfigurationId: record.id,
      configurationVersionId: null,
    };
  }
  // BE-27B captures the version snapshot as the full public configuration
  // record ({id, key, value, status, ...}) — the policy payload lives in
  // its `value`. Unwrap when that shape is present; anything else is
  // judged against the strict policy schema and fails closed.
  const snapshot = active.snapshot;
  const payload =
    isRecord(snapshot) && 'value' in snapshot ? snapshot.value : snapshot;
  const policy = parseArrivalVerificationPolicy(payload);
  if (!policy) {
    return {
      status: 'INVALID',
      buildingConfigurationId: record.id,
      configurationVersionId: active.id,
    };
  }
  if (!policy.enabled) {
    return {
      status: 'DISABLED',
      buildingConfigurationId: record.id,
      configurationVersionId: active.id,
    };
  }
  if (!policy.allowedMethods.includes('GPS')) {
    return {
      status: 'METHOD_NOT_ALLOWED',
      buildingConfigurationId: record.id,
      configurationVersionId: active.id,
    };
  }
  return {
    status: 'READY',
    policy,
    buildingConfigurationId: record.id,
    configurationVersionId: active.id,
  };
}

/** Maps a non-READY policy resolution to its owned failure reason. */
export function arrivalPolicyFailureReason(
  resolution: Exclude<ArrivalPolicyResolution, { status: 'READY' }>,
): HandymanVisitArrivalFailureReason {
  switch (resolution.status) {
    case 'INVALID':
      return 'ARRIVAL_POLICY_INVALID';
    case 'DISABLED':
      return 'GPS_NOT_ENABLED';
    case 'METHOD_NOT_ALLOWED':
      return 'GPS_METHOD_NOT_ALLOWED';
    default:
      return 'ARRIVAL_POLICY_UNAVAILABLE';
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic server-side distance                                  */
/* ------------------------------------------------------------------ */

/**
 * IUGG mean Earth radius in meters — a fixed geometric constant of the
 * deterministic haversine computation (NOT a geofence radius; the geofence
 * radius comes exclusively from the activated policy, never from code).
 */
export const EARTH_RADIUS_METERS = 6371008.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Deterministic great-circle distance in meters (server-side authority). */
export function haversineDistanceMeters(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number {
  const deltaLat = toRadians(toLatitude - fromLatitude);
  const deltaLng = toRadians(toLongitude - fromLongitude);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const a =
    sinLat * sinLat +
    Math.cos(toRadians(fromLatitude)) *
      Math.cos(toRadians(toLatitude)) *
      sinLng *
      sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ------------------------------------------------------------------ */
/* GPS evidence evaluation (pure — the service records the outcome)    */
/* ------------------------------------------------------------------ */

/** Raw client claim (evidence input only). */
export type GpsArrivalClaim = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
};

/**
 * Normalized evidence facts stored on the attempt row: finite claims are
 * retained EXACTLY as submitted (an out-of-range finite claim is honest
 * evidence of what the client sent); non-finite values are unrepresentable
 * and stored as null with their owned failure reason.
 */
export type GpsEvidenceEvaluation =
  | {
      ok: true;
      latitude: number;
      longitude: number;
      accuracyMeters: number | null;
    }
  | {
      ok: false;
      failureReason: HandymanVisitArrivalFailureReason;
      latitude: number | null;
      longitude: number | null;
      accuracyMeters: number | null;
    };

/**
 * Validates the claimed GPS evidence (ranges + accuracy), independent of
 * the policy. Deterministic owned reasons; the server decides, never the
 * client.
 */
export function evaluateGpsEvidence(
  claim: GpsArrivalClaim,
): GpsEvidenceEvaluation {
  const latitude = Number.isFinite(claim.latitude) ? claim.latitude : null;
  const longitude = Number.isFinite(claim.longitude) ? claim.longitude : null;
  const accuracyMeters =
    claim.accuracyMeters === undefined || claim.accuracyMeters === null
      ? null
      : Number.isFinite(claim.accuracyMeters)
        ? claim.accuracyMeters
        : null;

  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return {
      ok: false,
      failureReason: 'INVALID_COORDINATES',
      latitude,
      longitude,
      accuracyMeters,
    };
  }
  if (
    claim.accuracyMeters !== undefined &&
    claim.accuracyMeters !== null &&
    (!Number.isFinite(claim.accuracyMeters) || claim.accuracyMeters <= 0)
  ) {
    return {
      ok: false,
      failureReason: 'INVALID_ACCURACY',
      latitude,
      longitude,
      // A non-positive/non-finite accuracy claim is not storable evidence
      // (column CHECK) — the failure reason carries the fact.
      accuracyMeters: null,
    };
  }
  return { ok: true, latitude, longitude, accuracyMeters };
}

/**
 * The full server-side GPS decision for one attempt, given the pre-resolved
 * policy resolution (provenance-exact) and the raw claim. Evaluation order
 * is deterministic: policy fail-closed states first, then evidence
 * validation, then the distance comparison (inside-or-equal = VERIFIED;
 * boundary-inclusive by contract).
 */
export type GpsArrivalDecision = {
  result: 'VERIFIED' | 'FAILED';
  failureReason: HandymanVisitArrivalFailureReason | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  distanceMeters: number | null;
  buildingConfigurationId: string | null;
  configurationVersionId: string | null;
};

export function decideGpsArrival(
  resolution: ArrivalPolicyResolution,
  claim: GpsArrivalClaim,
): GpsArrivalDecision {
  if (resolution.status !== 'READY') {
    const evidence = evaluateGpsEvidence(claim);
    return {
      result: 'FAILED',
      failureReason: arrivalPolicyFailureReason(resolution),
      latitude: evidence.latitude,
      longitude: evidence.longitude,
      accuracyMeters: evidence.accuracyMeters,
      distanceMeters: null,
      // The consulted policy provenance is recorded even on fail-closed
      // outcomes — the attempt row must show exactly what the server
      // evaluated (null only when no configuration row exists at all).
      buildingConfigurationId: resolution.buildingConfigurationId,
      configurationVersionId: resolution.configurationVersionId,
    };
  }
  const evidence = evaluateGpsEvidence(claim);
  if (!evidence.ok) {
    return {
      result: 'FAILED',
      failureReason: evidence.failureReason,
      latitude: evidence.latitude,
      longitude: evidence.longitude,
      accuracyMeters: evidence.accuracyMeters,
      distanceMeters: null,
      // The policy WAS resolved and used for this decision — provenance is
      // recorded even though the claim itself failed.
      buildingConfigurationId: resolution.buildingConfigurationId,
      configurationVersionId: resolution.configurationVersionId,
    };
  }
  const distanceMeters = haversineDistanceMeters(
    resolution.policy.latitude,
    resolution.policy.longitude,
    evidence.latitude,
    evidence.longitude,
  );
  const within = distanceMeters <= resolution.policy.radiusMeters;
  return {
    result: within ? 'VERIFIED' : 'FAILED',
    failureReason: within ? null : 'DISTANCE_EXCEEDED',
    latitude: evidence.latitude,
    longitude: evidence.longitude,
    accuracyMeters: evidence.accuracyMeters,
    distanceMeters,
    buildingConfigurationId: resolution.buildingConfigurationId,
    configurationVersionId: resolution.configurationVersionId,
  };
}
