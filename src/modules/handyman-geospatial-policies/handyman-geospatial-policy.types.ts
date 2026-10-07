/**
 * CR-HM-07 Arrival Verification PART 03B — per-Building geospatial
 * policy + geofence signal types (FROZEN decision §2/§7). Signals
 * are RISK/CORROBORATION only; NONE of them is an arrival
 * VERIFIED/FAILED verdict.
 */

export const HANDYMAN_BUILDING_GEOSPATIAL_POLICY_STATUSES =
  ['ACTIVE', 'INACTIVE'] as const;

export type HandymanBuildingGeospatialPolicyStatus =
  (typeof HANDYMAN_BUILDING_GEOSPATIAL_POLICY_STATUSES)[number];

export interface HandymanBuildingGeospatialPolicyRecord {
  id: string;
  clientId: string;
  buildingId: string;
  referenceLatitude: number;
  referenceLongitude: number;
  geofenceRadiusMeters: number;
  maxAccuracyMeters: number;
  maxLocationAgeSeconds: number;
  status: HandymanBuildingGeospatialPolicyStatus;
  effectiveFrom: Date;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicHandymanBuildingGeospatialPolicy =
  Omit<
    HandymanBuildingGeospatialPolicyRecord,
    'effectiveFrom' | 'createdAt' | 'updatedAt'
  > & {
    effectiveFrom: string;
    createdAt: string;
    updatedAt: string;
  };

/**
 * Operator-configured policy input. clientId/status/authority fields
 * are NEVER caller-authored — the building derives the client and
 * lifecycle status is server-managed.
 */
export interface CreateHandymanBuildingGeospatialPolicyInput {
  buildingId: string;
  referenceLatitude: number;
  referenceLongitude: number;
  geofenceRadiusMeters: number;
  maxAccuracyMeters: number;
  maxLocationAgeSeconds: number;
  effectiveFrom?: string | null;
}

/** Internal device observation (signal, metadata — never authority). */
export interface HandymanDeviceLocationInput {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
}

/** Geofence evaluation input: target + device signal ONLY. */
export interface EvaluateHandymanGeofenceSignalInput {
  executionScopeId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
}

export const HANDYMAN_GEOFENCE_SIGNALS =
  ['INSIDE', 'OUTSIDE', 'LOW_ACCURACY', 'UNAVAILABLE'] as const;

export type HandymanGeofenceSignalKind =
  (typeof HANDYMAN_GEOFENCE_SIGNALS)[number];

/**
 * Bounded provider-neutral result (PART 03A §8 normalization
 * convention). Valid only as a signal — NEVER an arrival verdict.
 */
export interface HandymanGeofenceSignalResult {
  signal: HandymanGeofenceSignalKind;
  distanceMeters: number | null;
  policyId: string | null;
  /** Server clock — evaluation authority. */
  evaluatedAt: string;
}
