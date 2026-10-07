import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { hashSessionToken } from '../auth/session.token';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  arrivalChallengeInvalidError,
  arrivalChallengeNotAuthorizedError,
  arrivalChallengeNotFoundError,
  arrivalChallengeScopeNotAuthorizedError,
  handymanArrivalChallengeRepository,
} from '../handyman-arrival-challenges';
import type { HandymanArrivalChallengeRecord }
  from '../handyman-arrival-challenges';
import {
  resolveHandymanArrivalQrSignal,
  resolveHandymanExpectedArrivalLocation,
} from '../handyman-arrival-locations';
import {
  evaluateHandymanBuildingGeofenceSignal,
  handymanGeospatialPolicyRepository,
} from '../handyman-geospatial-policies';
import type { HandymanGeofenceSignalResult }
  from '../handyman-geospatial-policies';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import { resolveHandymanAssignmentLead }
  from '../handyman-scope-assignments';
import { handymanScopeAssignmentRepository }
  from '../handyman-scope-assignments';
import { recordOperationalEvent } from '../operational-events';
import { isValidUuid } from '../clients';
import { arrivalResultConflictError }
  from './handyman-arrival-result.errors';
import {
  findHandymanArrivalResultByChallengeId,
  insertHandymanArrivalVerificationResult,
  listHandymanArrivalResultsByExecutionScope,
} from './handyman-arrival-result.repository';
import type {
  HandymanArrivalResultGeofenceSignal,
  HandymanArrivalResultStatus,
  HandymanArrivalVerificationResultRecord,
  HandymanCustomerCareArrivalResultItem,
  HandymanCustomerCareArrivalVerificationProjection,
  PublicHandymanArrivalVerificationResult,
} from './handyman-arrival-result.types';

/**
 * CR-HM-07 PART 04B — internal ATOMIC terminal arrival evaluator
 * (governance FROZEN: docs/handyman/CR-HM-07_PART04_ARRIVAL_RESULT_
 * GOVERNANCE.md). Composition ONLY of existing authorities:
 * PART 01 challenge lifecycle, PART 02 expected-location snapshot +
 * QR resolver, PART 03B per-Building geofence signal, PART 04A
 * immutable result persistence.
 *
 * INTERNAL ONLY: no HTTP/OpenAPI, NO API.CO.ID call (enrichment
 * fields persist NULL — corrobation composition comes later, outside
 * this authoritative decision), no work-session/check-in/attendance/
 * billing/BAST/FM semantics.
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_ARRIVAL_RESULT_INVALID_UUID:${field}`);
  }
  return raw;
}

/** Caller input: MINIMUM ONLY (positional, bounded). */
export type EvaluateHandymanArrivalInput = {
  executionScopeId: string;
  challengeToken: string;
  qrOpaqueCode: string;
  /** Validated device observation; null = no device signal. */
  deviceLocation: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    capturedAt: string;
  } | null;
};

type TerminalDecision = {
  status: HandymanArrivalResultStatus;
  primaryReason: string;
  consume: boolean;
  qrSignal: 'MATCH' | 'MISMATCH' | 'UNKNOWN' | 'INACTIVE';
  identifierId: string | null;
  geofence: HandymanGeofenceSignalResult | null;
};

async function journalChallenge(
  tx: Pick<PoolClient, 'query'>,
  record: HandymanArrivalChallengeRecord,
  eventType: string,
  summary: string,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: record.clientId,
      eventType,
      entityType: 'HANDYMAN_ARRIVAL_CHALLENGE',
      entityId: record.id,
      actorUserId: record.actorUserId,
      summary,
      metadata: {
        challengeId: record.id,
        executionScopeId: record.executionScopeId,
        assignmentId: record.assignmentId,
        status: record.status,
      },
    },
    tx,
  );
}

/**
 * Runs ONE terminal evaluation and returns the immutable result.
 * The actor is the AUTHENTICATED user context; the challenge is bound
 * server-side by (scope, actor, token). REPLAY: an existing immutable
 * result for the bound challenge returns before ANY reevaluation
 * (no second result, no second consume).
 */
export async function evaluateHandymanArrivalVerification(
  input: EvaluateHandymanArrivalInput,
  actorUserId: string,
  options?: { geofence?: (typeof evaluateHandymanBuildingGeofenceSignal) },
): Promise<PublicHandymanArrivalVerificationResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const token = typeof input.challengeToken === 'string'
    ? input.challengeToken
    : '';
  if (token.length === 0) throw arrivalChallengeInvalidError();
  const evaluateGeofence = options?.geofence
    ?? evaluateHandymanBuildingGeofenceSignal;

  // 1+2: scope exists, Client access, AUTHORIZED gate (evaluation
  // REJECTS; no result, no consume).
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined, scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (scope.status !== 'AUTHORIZED') {
    throw arrivalChallengeScopeNotAuthorizedError();
  }
  if (!(await contextAccessService.canAccessClient(
    actorUserId, scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }

  // REPLAY FIRST: challenge bound by scope + authenticated actor +
  // token. A stored result for it returns before ANY state lock.
  const tokenHash = hashSessionToken(token);
  const challenge = await handymanArrivalChallengeRepository
    .findByScopeActorTokenHash(undefined, scopeUuid, actorUserId,
      tokenHash);
  if (challenge) {
    const existing = await findHandymanArrivalResultByChallengeId(
      challenge.id,
    );
    if (existing) return existing;
  }
  if (!challenge) {
    // Invalid token/binding — reject with the bounded PART 01 shape;
    // NO result, NO consume.
    throw arrivalChallengeInvalidError();
  }
  if (challenge.status === 'CONSUMED') {
    // Defensive impossibility under the atomicity guarantee: a
    // consumed challenge without a result must never be recreated.
    throw arrivalResultConflictError(challenge.id);
  }

  // Authority reads (pure; deterministic) — server-side only:
  // - current ACTIVE assignment + authoritative CURRENT Crew Lead
  // - expected-location immutable snapshot
  // - QR signal (PART 02 resolver ONLY)
  // - geofence signal (PART 03B evaluator ONLY) when a device
  //   observation is supplied
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid, actorUserId,
  );
  const actorIsAuthoritativeLead = Boolean(
    resolution && resolution.leadUserId === actorUserId
      && resolution.assignmentId === challenge.assignmentId,
  );
  if (!actorIsAuthoritativeLead && !resolution) {
    throw arrivalChallengeNotAuthorizedError();
  }
  const expected = await resolveHandymanExpectedArrivalLocation(
    scopeUuid, actorUserId,
  );
  const qr = await resolveHandymanArrivalQrSignal(
    { executionScopeId: scopeUuid, rawValue: input.qrOpaqueCode },
    actorUserId,
  );
  let geofence: HandymanGeofenceSignalResult | null = null;
  if (input.deviceLocation) {
    geofence = await evaluateGeofence(
      {
        executionScopeId: scopeUuid,
        latitude: input.deviceLocation.latitude,
        longitude: input.deviceLocation.longitude,
        accuracyMeters: input.deviceLocation.accuracyMeters,
        capturedAt: input.deviceLocation.capturedAt,
      },
      actorUserId,
    );
  }

  // Decision — governance precedence, single primary reason.
  const nowMs = Date.now();
  let decision: TerminalDecision;
  if (!actorIsAuthoritativeLead) {
    decision = {
      status: 'FAILED',
      primaryReason: 'ACTOR_ASSIGNMENT_INVALID',
      consume: true,
      qrSignal: qr.signal,
      identifierId: qr.identifierId,
      geofence,
    };
  } else if (challenge.expiresAt.getTime() <= nowMs) {
    decision = {
      status: 'EXPIRED',
      primaryReason: 'CHALLENGE_EXPIRED',
      consume: false, // expiry PROJECTION instead
      qrSignal: qr.signal,
      identifierId: qr.identifierId,
      geofence,
    };
  } else if (qr.signal === 'MISMATCH') {
    decision = {
      status: 'FAILED', primaryReason: 'QR_MISMATCH', consume: true,
      qrSignal: qr.signal, identifierId: qr.identifierId, geofence,
    };
  } else if (qr.signal === 'UNKNOWN') {
    decision = {
      status: 'MANUAL_REVIEW_REQUIRED', primaryReason: 'QR_UNKNOWN',
      consume: true,
      qrSignal: qr.signal, identifierId: qr.identifierId, geofence,
    };
  } else if (qr.signal === 'INACTIVE') {
    decision = {
      status: 'MANUAL_REVIEW_REQUIRED', primaryReason: 'QR_INACTIVE',
      consume: true,
      qrSignal: qr.signal, identifierId: qr.identifierId, geofence,
    };
  } else {
    // QR MATCH: geofence chain decides the remainder.
    let policy = geofence?.policyId ?? null;
    let geofenceSignal: HandymanArrivalResultGeofenceSignal | null = null;
    let distanceMeters: number | null = null;
    let status: HandymanArrivalResultStatus;
    let primaryReason: string;
    if (geofence) {
      geofenceSignal = geofence.signal;
      distanceMeters = geofence.distanceMeters;
    }
    if (!geofence) {
      // No device observation supplied at all.
      const active = await handymanGeospatialPolicyRepository
        .findActivePolicyByBuilding(undefined, expected.buildingId);
      policy = active?.id ?? null;
      if (!active) {
        status = 'MANUAL_REVIEW_REQUIRED';
        primaryReason = 'NO_GEOSPATIAL_POLICY';
      } else {
        status = 'MANUAL_REVIEW_REQUIRED';
        primaryReason = 'GEOFENCE_UNAVAILABLE';
        geofenceSignal = 'UNAVAILABLE';
      }
    } else if (!policy) {
      status = 'MANUAL_REVIEW_REQUIRED';
      primaryReason = 'NO_GEOSPATIAL_POLICY';
    } else if (geofenceSignal === 'LOW_ACCURACY') {
      status = 'MANUAL_REVIEW_REQUIRED';
      primaryReason = 'LOW_ACCURACY';
    } else if (geofenceSignal === 'UNAVAILABLE') {
      status = 'MANUAL_REVIEW_REQUIRED';
      primaryReason = 'GEOFENCE_UNAVAILABLE';
    } else if (geofenceSignal === 'OUTSIDE') {
      status = 'FAILED';
      primaryReason = 'GEOFENCE_OUTSIDE';
    } else {
      status = 'VERIFIED';
      primaryReason = 'ALL_POSITIVE_EVIDENCE';
    }
    decision = {
      status, primaryReason, consume: true,
      qrSignal: qr.signal, identifierId: qr.identifierId,
      geofence: geofence
        ? { ...geofence, policyId: policy ?? geofence.policyId }
        : null,
    };
  }

  // ATOMIC TERMINAL WRITE — one transaction carries BOTH the
  // challenge lifecycle projection (consume exactly once, or the
  // EXPIRED projection) AND the immutable result insert; any failure
  // rolls back both (no CONSUMED-without-result / result-with-PENDING
  // state can ever be committed).
  return withTransaction(async (tx) => {
    const locked = await handymanArrivalChallengeRepository
      .lockChallengeById(tx, challenge.id);
    if (!locked) throw arrivalChallengeNotFoundError();
    // Post-lock REPLAY (race-safe): a concurrent terminal commit wins;
    // return the EXISTING immutable result unchanged.
    const existing = await findHandymanArrivalResultByChallengeId(
      tx, challenge.id,
    );
    if (existing) return existing;
    let effectiveDecision = decision;
    let projectedChallenge = locked;
    if (decision.consume) {
      const consumed = await handymanArrivalChallengeRepository
        .consumeIfPending(tx, challenge.id);
      if (!consumed) {
        // Server time crossed TTL between decision and write: fall
        // back to the EXPIRED terminal atomically (no consume).
        const expired = await handymanArrivalChallengeRepository
          .expireIfPendingOverdue(tx, challenge.id);
        if (!expired) throw arrivalResultConflictError(challenge.id);
        projectedChallenge = expired;
        effectiveDecision = {
          ...decision,
          status: 'EXPIRED',
          primaryReason: 'CHALLENGE_EXPIRED',
          consume: false,
        };
      } else {
        projectedChallenge = consumed;
        await journalChallenge(
          tx,
          consumed,
          'ARRIVAL_CHALLENGE_CONSUMED',
          'Handyman arrival challenge consumed exactly once by terminal arrival evaluation.',
        );
      }
    } else {
      const expired = await handymanArrivalChallengeRepository
        .expireIfPendingOverdue(tx, challenge.id);
      if (!expired) throw arrivalResultConflictError(challenge.id);
      projectedChallenge = expired;
      await journalChallenge(
        tx,
        expired,
        'ARRIVAL_CHALLENGE_EXPIRED',
        'Handyman arrival challenge expired before terminal evaluation (EXPIRED result).',
      );
    }
    const saved = await insertHandymanArrivalVerificationResult(
      {
        clientId: projectedChallenge.clientId,
        executionScopeId: projectedChallenge.executionScopeId,
        assignmentId: projectedChallenge.assignmentId,
        actorUserId: projectedChallenge.actorUserId,
        challengeId: projectedChallenge.id,
        expectedBuildingId: expected.buildingId,
        expectedFloorId: expected.floorId,
        expectedAreaId: expected.areaId,
        expectedRoomId: expected.roomId,
        expectedSpaceId: expected.spaceId,
        qrSignal: effectiveDecision.qrSignal,
        deviceLatitude: input.deviceLocation?.latitude ?? null,
        deviceLongitude: input.deviceLocation?.longitude ?? null,
        deviceAccuracyMeters: input.deviceLocation?.accuracyMeters ?? null,
        deviceCapturedAt: input.deviceLocation?.capturedAt
          ? new Date(input.deviceLocation.capturedAt)
          : null,
        geofenceSignal:
          (effectiveDecision.geofence?.signal
            ?? (effectiveDecision.status === 'MANUAL_REVIEW_REQUIRED'
              && effectiveDecision.primaryReason === 'GEOFENCE_UNAVAILABLE'
              ? 'UNAVAILABLE'
              : null)) as HandymanArrivalResultGeofenceSignal | null,
        distanceMeters: effectiveDecision.geofence?.distanceMeters ?? null,
        geospatialPolicyId: effectiveDecision.geofence?.policyId
          ?? (effectiveDecision.status === 'MANUAL_REVIEW_REQUIRED'
            ? null
            : (effectiveDecision.geofence?.policyId ?? null)),
        // PART 04B never calls the provider: enrichment NULL.
        reverseGeocodeStatus: null,
        reverseGeocodeDisplayName: null,
        reverseGeocodeProvince: null,
        reverseGeocodeRegency: null,
        reverseGeocodeDistrict: null,
        reverseGeocodeVillage: null,
        reverseGeocodePostalCode: null,
        reverseGeocodeProviderPlaceId: null,
        status: effectiveDecision.status,
        primaryReason: effectiveDecision.primaryReason,
        evaluatedAt: new Date(),
      },
      tx,
    );
    return saved;
  });
}

function toCustomerCareArrivalResultItem(
  record: HandymanArrivalVerificationResultRecord,
): HandymanCustomerCareArrivalResultItem {
  return {
    id: record.id,
    executionScopeId: record.executionScopeId,
    assignmentId: record.assignmentId,
    challengeId: record.challengeId,
    expectedLocation: {
      buildingId: record.expectedBuildingId,
      floorId: record.expectedFloorId,
      areaId: record.expectedAreaId,
      roomId: record.expectedRoomId,
      spaceId: record.expectedSpaceId,
    },
    status: record.status,
    primaryReason: record.primaryReason,
    qrSignal: record.qrSignal,
    geofenceSignal: record.geofenceSignal,
    distanceMeters: record.distanceMeters,
    evaluatedAt: record.evaluatedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * CR-HM-17 GAP PART 03 — bounded Customer Care arrival verification read
 * projection for an execution scope. Enforces `canAccessClient` via
 * `resolveHandymanExpectedArrivalLocation`; returns scope-keyed status and
 * expected location facts with zero challenge token or token hash exposure.
 */
export async function getHandymanArrivalVerificationByScope(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanCustomerCareArrivalVerificationProjection> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');

  const expectedLocation = await resolveHandymanExpectedArrivalLocation(
    scopeUuid,
    actorUserId,
  );
  const records = await listHandymanArrivalResultsByExecutionScope(
    undefined,
    scopeUuid,
  );
  const results = records.map(toCustomerCareArrivalResultItem);

  return {
    executionScopeId: scopeUuid,
    expectedLocation,
    arrivalVerified: results.some((r) => r.status === 'VERIFIED'),
    latestResult: results.length > 0 ? results[results.length - 1] : null,
    results,
  };
}

export const handymanArrivalResultService = {
  evaluateHandymanArrivalVerification,
  getHandymanArrivalVerificationByScope,
};
