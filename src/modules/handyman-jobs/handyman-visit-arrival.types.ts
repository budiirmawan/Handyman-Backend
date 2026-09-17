import type { PublicHandymanVisitPresence } from './handyman-visit-presence.types';

/**
 * CR-HM-BE-06 RUN 1 — Handyman visit arrival attempt types.
 *
 * An arrival attempt is an APPEND-ONLY evidence row: the client supplies GPS
 * coordinates as evidence input (never a decision), the SERVER decides
 * VERIFIED/FAILED against the building's ACTIVE, version-activated arrival
 * policy, and at most one VERIFIED arrival exists per visit (partial unique
 * index). Nothing here is attendance, a work-order/vendor-work transition,
 * or a work-session fact.
 */

/** How the server was asked to verify the arrival. */
export const HANDYMAN_VISIT_ARRIVAL_METHODS = ['GPS', 'ASSISTED'] as const;
export type HandymanVisitArrivalMethod =
  (typeof HANDYMAN_VISIT_ARRIVAL_METHODS)[number];

export function isHandymanVisitArrivalMethod(
  value: unknown,
): value is HandymanVisitArrivalMethod {
  return (
    typeof value === 'string' &&
    (HANDYMAN_VISIT_ARRIVAL_METHODS as readonly string[]).includes(value)
  );
}

/** The server's decision — never a client input. */
export const HANDYMAN_VISIT_ARRIVAL_RESULTS = ['VERIFIED', 'FAILED'] as const;
export type HandymanVisitArrivalResult =
  (typeof HANDYMAN_VISIT_ARRIVAL_RESULTS)[number];

/**
 * Server-owned failure reasons (exhaustive; the DB CHECK mirrors this list).
 * A FAILED attempt always carries exactly one.
 */
export const HANDYMAN_VISIT_ARRIVAL_FAILURE_REASONS = [
  /** Claimed latitude/longitude missing, non-finite, or out of range. */
  'INVALID_COORDINATES',
  /** Claimed accuracy present but non-finite or not a positive distance. */
  'INVALID_ACCURACY',
  /** No ACTIVE policy row, or versions exist with none ACTIVE (fail-closed). */
  'ARRIVAL_POLICY_UNAVAILABLE',
  /** Policy snapshot failed the Handyman schema validation (fail-closed). */
  'ARRIVAL_POLICY_INVALID',
  /** Policy resolved but arrival verification is not enabled. */
  'GPS_NOT_ENABLED',
  /** Policy resolved and enabled but GPS is not an allowed method. */
  'GPS_METHOD_NOT_ALLOWED',
  /** Server-computed distance exceeded the configured radius. */
  'DISTANCE_EXCEEDED',
] as const;
export type HandymanVisitArrivalFailureReason =
  (typeof HANDYMAN_VISIT_ARRIVAL_FAILURE_REASONS)[number];

/** Full database record of one append-only arrival attempt. */
export type HandymanVisitArrivalRecord = {
  id: string;
  clientId: string;
  handymanServiceVisitId: string;
  verificationMethod: HandymanVisitArrivalMethod;
  verificationResult: HandymanVisitArrivalResult;
  /** Server-authoritative receipt time. */
  receivedAt: Date;
  /** Nullable CLIENT-CLAIMED evidence timestamp (offline tolerance). */
  occurredAt: Date | null;
  /** Raw claimed GPS evidence (GPS attempts with finite claims only). */
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  /** Server-computed distance to the configured policy point (GPS only). */
  distanceMeters: number | null;
  /** Exact policy provenance the GPS decision used (never for ASSISTED). */
  buildingConfigurationId: string | null;
  configurationVersionId: string | null;
  /** Mandatory non-empty override reason (ASSISTED only). */
  assistedReason: string | null;
  failureReason: HandymanVisitArrivalFailureReason | null;
  recordedByUserId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
};

/**
 * Safe public representation — IDs, method/result, timestamps, provenance
 * ids and the failure reason ONLY. Privacy canary: raw GPS coordinates,
 * accuracy and the computed distance are evidence stored on the record but
 * deliberately excluded from the read model (governance: exact location
 * data never leaks through read surfaces; field evidence travels through
 * the BE-07/BE-15E/BE-25E evidence foundations instead).
 */
export type PublicHandymanVisitArrival = {
  id: string;
  clientId: string;
  handymanServiceVisitId: string;
  verificationMethod: HandymanVisitArrivalMethod;
  verificationResult: HandymanVisitArrivalResult;
  receivedAt: string;
  occurredAt: string | null;
  buildingConfigurationId: string | null;
  configurationVersionId: string | null;
  assistedReason: string | null;
  failureReason: HandymanVisitArrivalFailureReason | null;
  recordedByUserId: string;
  createdAt: string;
};

/** GPS arrival command facts (business facts only — the client never
 * supplies a result, a radius, a policy point, or a building identity). */
export type RecordGpsArrivalInput = {
  /** Client-claimed evidence coordinates. */
  latitude: number;
  longitude: number;
  /** Optional client-claimed fix accuracy in meters. */
  accuracyMeters?: number | null;
  /** Optional client-claimed occurrence time (evidence only). */
  occurredAt?: Date | string | null;
  /** Client idempotency key (required; unique per client). */
  idempotencyKey: string;
};

/** Staff-assisted arrival command facts (a provenance-bearing override). */
export type RecordAssistedArrivalInput = {
  /** Mandatory non-empty operational reason. */
  assistedReason: string;
  /** Optional client-claimed occurrence time (evidence only). */
  occurredAt?: Date | string | null;
  /** Client idempotency key (required; unique per client). */
  idempotencyKey: string;
};

/**
 * Command result. `converged` is true when NO new attempt row was created
 * because the command replayed onto its own idempotency key or onto the
 * visit's already-established VERIFIED arrival — the returned arrival is
 * always the authoritative (original) fact.
 */
export type HandymanVisitArrivalCommandResult = {
  arrival: PublicHandymanVisitArrival;
  /** Crew presence snapshot of the VERIFIED arrival (empty when FAILED). */
  presence: PublicHandymanVisitPresence[];
  converged: boolean;
};
