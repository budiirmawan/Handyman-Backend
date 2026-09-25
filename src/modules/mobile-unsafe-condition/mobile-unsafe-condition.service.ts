import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { assetNotFoundError, assetRepository } from '../assets';
import {
  assetFailureService,
  type PublicAssetFailure,
} from '../asset-failures';
import { contextAccessService } from '../context-access';
import { incidentNumberAlreadyExistsError } from '../incidents';
import {
  executeIdempotent,
  computeRequestFingerprint,
} from '../request-idempotency';
import {
  UNSAFE_CONDITION_OPERATIONAL_IMPACT,
  type MobileUnsafeConditionInput,
  type MobileUnsafeConditionReported,
} from './mobile-unsafe-condition.types';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — mobile unsafe condition report.
 *
 * ONE concern: let a field caller record an authoritative unsafe condition
 * against an Asset. The record IS a canonical BE-21C Asset Failure with
 * `operationalImpact = SAFETY_RISK`, created through BE-21C's own service —
 * the same service, the same repository, the same transaction, the same
 * `ASSET_FAILURE_REPORTED` operational event. Nothing about Asset Failure
 * creation is re-implemented here.
 *
 * AUTHORITY CHAIN (in order, all server-side):
 *   1. the caller is authenticated (`authenticationMiddleware`);
 *   2. the caller holds `asset_failure.report` (`requirePermission` —
 *      deliberately NOT `asset_failure.manage`, which is management authority);
 *   3. the Asset named in the path exists                    → 404 ASSET_NOT_FOUND
 *   4. the caller has Building access to the Asset's Building → 403
 *      BUILDING_ACCESS_DENIED, the same canonical error `/assets/:id` uses;
 *   5. `clientId` / `buildingId` are derived from the Asset's AUTHORITATIVE
 *      context — never from the body;
 *   6. BE-21C's own `createAssetFailure` re-validates the Asset binding,
 *      rejects a RETIRED Asset, and derives severity/priority defaults.
 *
 * Steps 3–4 run before any mutation, and 5–6 are BE-21C's, so this command
 * cannot become a weaker second creation path: it is the SAME path.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No current-shift requirement and no active-assignment requirement. BE-21C
 * (and BE-21A under it) has never required either for a report — its own
 * authority is session + permission + Building scope. The current-shift /
 * active-task-assignment chain exists in this repository only for MOB-C04/C05
 * CHECKLIST EXECUTION commands (and is asserted there from an authoritative
 * bound execution), which is a different authority shape entirely. Imposing it
 * here would be inventing a rule this domain does not have.
 *
 * No OUT_OF_SERVICE / ISOLATED / SHUT_DOWN / RETURN_TO_SERVICE. Recording an
 * unsafe condition creates an OPERATIONAL RECORD only: `assets.status` and
 * `equipment_profiles.status` are untouched, no Work Order or Finding is
 * transitioned, and no CRITICAL is inferred. Those are later RN-10 PARTs.
 */

/** Bounded retries on the (astronomically unlikely) Incident-number collision. */
const UNSAFE_CONDITION_NUMBER_MAX_ATTEMPTS = 3;

function isIncidentNumberConflict(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === ERROR_CODES.INCIDENT_NUMBER_ALREADY_EXISTS
  );
}

function toReported(
  record: PublicAssetFailure,
): MobileUnsafeConditionReported {
  return {
    incidentId: record.id,
    incidentNumber: record.incidentNumber,
    assetId: record.asset.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    // Taken from the CONSTANT, never read back: this command sets it, and
    // reading it back would let a domain regression masquerade as a contract
    // that still holds.
    operationalImpact: UNSAFE_CONDITION_OPERATIONAL_IMPACT,
    failureCategory: record.failureCategory,
    failureStatus: record.failureStatus,
    incidentStatus: record.incidentStatus,
    occurredAt: record.occurredAt,
    reportedByUserId: record.reportedByUserId,
    reportedAt: record.reportedAt,
    createdAt: record.createdAt,
    canonicalRead: {
      operationId: 'getAssetFailure',
      path: `/asset-failures/${record.id}`,
    },
  };
}

/**
 * Reports an unsafe condition against one Asset — transactionally idempotent.
 *
 * `assetId` comes from the path; `clientId` and `buildingId` are resolved from
 * the Asset's canonical context; `operationalImpact` is pinned to `SAFETY_RISK`
 * and the initial status to `OPEN`; the reporting actor is the authenticated
 * caller. None of these is accepted from the request body.
 *
 * Idempotency (PART 02):
 * - Authority (auth, asset_failure.report via route, asset resolution,
 *   Building access) is checked BEFORE any idempotency claim — a failure
 *   there must not create a request_idempotency_records row.
 * - Fingerprint is the canonical semantic object
 *   {assetId,title,description,failureCategory,occurredAt} where
 *   assetId is canonical path UUID, title trimmed, description null-consistent,
 *   failureCategory effective including default OTHER, occurredAt normalized
 *   ISO instant (null when omitted to allow replay), sha256Hex(stableJson(...)).
 * - OperationKey is server-defined exact 'reportMobileUnsafeCondition'.
 * - Idempotency-Key header is REQUIRED, parsed via PART 01 validator, never
 *   stored/logged raw — only SHA-256 hash is persisted.
 * - The incident-number UNC_ retry loop is preserved OUTSIDE the idempotency
 *   transaction: each attempt starts a new executeIdempotent transaction that
 *   claims the key and tries creation; a UNIQUE collision rolls back the whole
 *   attempt including the claim, then outer loop retries. Do NOT retry
 *   IDEMPOTENCY_CONFLICT, permission, validation, building errors.
 * - Inside work(client), creation uses the injected transaction executor so
 *   claim + incident + specialization + ASSET_FAILURE_REPORTED event + stored
 *   response are atomic.
 */
export async function reportMobileUnsafeCondition(
  assetId: string,
  actorUserId: string,
  input: MobileUnsafeConditionInput,
  idempotencyKey: string,
): Promise<MobileUnsafeConditionReported> {
  // Authority BEFORE replay — must not poison idempotency key.
  const asset = await assetRepository.findById(assetId);
  if (!asset) throw assetNotFoundError();

  // Building isolation is asserted BEFORE the write, using the same authority
  // the rest of the codebase uses, so holding the permission is never
  // sufficient to reach another Building.
  await contextAccessService.assertBuildingAccess(actorUserId, asset.buildingId);

  const effectiveOccurredAt = input.occurredAt ?? new Date();

  // Fingerprint: canonical semantic object, no incidentNumber/clientId/buildingId
  const canonical = {
    assetId: asset.id,
    title: input.title,
    description: input.description ?? null,
    failureCategory: input.failureCategory ?? 'OTHER',
    occurredAt: input.occurredAt ? input.occurredAt.toISOString() : null,
  };
  const requestFingerprint = computeRequestFingerprint(canonical);

  const operationKey = 'reportMobileUnsafeCondition';

  for (let attempt = 0; attempt < UNSAFE_CONDITION_NUMBER_MAX_ATTEMPTS; attempt++) {
    const incidentNumber = `UNC_${randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      const result = await executeIdempotent({
        actorUserId,
        operationKey,
        idempotencyKey,
        requestFingerprint,
        work: async (client) => {
          const created = await assetFailureService.createAssetFailure(
            {
              // Derived from the Asset's authoritative context, never the body.
              buildingId: asset.buildingId,
              incidentNumber,
              title: input.title,
              ...(input.description === undefined
                ? {}
                : { description: input.description }),
              // Path-derived, and re-validated against the derived context by BE-21C.
              assetId: asset.id,
              failureCategory: input.failureCategory ?? 'OTHER',
              occurredAt: effectiveOccurredAt,
              // The unsafe-condition representation. Pinned, never caller-supplied.
              operationalImpact: UNSAFE_CONDITION_OPERATIONAL_IMPACT,
            },
            actorUserId,
            client,
          );
          const reported = toReported(created);
          return {
            responseStatus: 201,
            responseBody: reported,
          };
        },
      });

      // On first execution or replay, responseBody is the canonical reported payload.
      return result.responseBody as MobileUnsafeConditionReported;
    } catch (error) {
      // Retry ONLY the server-generated number collision. Every other failure
      // (IDEMPOTENCY_CONFLICT, permission, validation, building, unknown asset)
      // propagates unchanged — the idempotency transaction rolled back, so no
      // partial Asset Failure exists and no FAILED record is left.
      if (!isIncidentNumberConflict(error)) throw error;
    }
  }

  throw incidentNumberAlreadyExistsError();
}

export const mobileUnsafeConditionService = {
  reportMobileUnsafeCondition,
};
