/**
 * CR-HM-07 Arrival Verification PART 04A — terminal arrival RESULT
 * persistence types (persistence ONLY per the FROZEN PART 04
 * governance; no evaluator, no decision logic lives here).
 *
 * The result row is the immutable audit snapshot (governance §16):
 * identity bindings, expected-location snapshot, QR/device/geofence
 * signal snapshots, optional bounded reverse-geocode corroboration
 * fields, terminal status + bounded primary reason, evaluatedAt.
 * NEVER raw provider payloads or secret material — no such column
 * exists.
 */

export const HANDYMAN_ARRIVAL_RESULT_STATUSES = [
  'VERIFIED',
  'FAILED',
  'MANUAL_REVIEW_REQUIRED',
  'EXPIRED',
] as const;

export type HandymanArrivalResultStatus =
  (typeof HANDYMAN_ARRIVAL_RESULT_STATUSES)[number];

/**
 * Frozen bounded primary reason codes (governance §14), paired with
 * status. No free-form authoritative reason text exists anywhere.
 */
export const HANDYMAN_ARRIVAL_RESULT_REASONS = {
  VERIFIED: ['ALL_POSITIVE_EVIDENCE'],
  FAILED: ['QR_MISMATCH', 'GEOFENCE_OUTSIDE', 'ACTOR_ASSIGNMENT_INVALID'],
  MANUAL_REVIEW_REQUIRED: [
    'QR_UNKNOWN',
    'QR_INACTIVE',
    'NO_GEOSPATIAL_POLICY',
    'LOW_ACCURACY',
    'GEOFENCE_UNAVAILABLE',
  ],
  EXPIRED: ['CHALLENGE_EXPIRED'],
} as const;

export type HandymanArrivalResultReason<
  S extends HandymanArrivalResultStatus = HandymanArrivalResultStatus,
> = (typeof HANDYMAN_ARRIVAL_RESULT_REASONS)[S][number];

export const HANDYMAN_ARRIVAL_RESULT_GEOFENCE_SIGNALS = [
  'INSIDE',
  'OUTSIDE',
  'LOW_ACCURACY',
  'UNAVAILABLE',
] as const;

export type HandymanArrivalResultGeofenceSignal =
  (typeof HANDYMAN_ARRIVAL_RESULT_GEOFENCE_SIGNALS)[number];

export const HANDYMAN_ARRIVAL_RESULT_REVERSE_GEOCODE_STATUSES = [
  'AVAILABLE',
  'REVERSE_GEOCODE_UNAVAILABLE',
  'REVERSE_GEOCODE_AUTH_FAILURE',
] as const;

export type HandymanArrivalResultReverseGeocodeStatus =
  (typeof HANDYMAN_ARRIVAL_RESULT_REVERSE_GEOCODE_STATUSES)[number];

/** Full row shape (persistence record). */
export type HandymanArrivalVerificationResultRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  actorUserId: string;
  challengeId: string;
  expectedBuildingId: string;
  expectedFloorId: string | null;
  expectedAreaId: string | null;
  expectedRoomId: string | null;
  expectedSpaceId: string | null;
  qrSignal: string;
  deviceLatitude: number | null;
  deviceLongitude: number | null;
  deviceAccuracyMeters: number | null;
  deviceCapturedAt: Date | null;
  geofenceSignal: HandymanArrivalResultGeofenceSignal | null;
  distanceMeters: number | null;
  geospatialPolicyId: string | null;
  reverseGeocodeStatus:
    | HandymanArrivalResultReverseGeocodeStatus
    | null;
  reverseGeocodeDisplayName: string | null;
  reverseGeocodeProvince: string | null;
  reverseGeocodeRegency: string | null;
  reverseGeocodeDistrict: string | null;
  reverseGeocodeVillage: string | null;
  reverseGeocodePostalCode: string | null;
  reverseGeocodeProviderPlaceId: string | null;
  status: HandymanArrivalResultStatus;
  primaryReason: string;
  evaluatedAt: Date;
  createdAt: Date;
};

/**
 * Insert input = the same snapshot material (id/createdAt generated).
 * NULLABLE signal columns mirror governance: e.g. NO_GEOSPATIAL_POLICY
 * / EXPIRED rows carry null device/geofence payloads; enrichment
 * fields are optional corroboration metadata.
 */
export type NewHandymanArrivalVerificationResult = Omit<
  HandymanArrivalVerificationResultRecord,
  'id' | 'createdAt'
> & { id?: string };

/** Public projection (identical — row contains nothing secret). */
export type PublicHandymanArrivalVerificationResult =
  HandymanArrivalVerificationResultRecord;
