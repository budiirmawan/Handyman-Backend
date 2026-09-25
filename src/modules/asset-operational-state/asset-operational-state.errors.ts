import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 / PART 03 — operational-state errors.
 *
 * Each failure is DISTINCT and deterministic. Collapsing them would make RN-10
 * undiagnosable: "you asked for the state it is already in", "that transition
 * needs the governed return command", "the Asset is retired", "an unresolved
 * SAFETY_RISK failure blocks this", and "someone else moved it first" require
 * five different client responses, and only the last is retryable after a plain
 * reload.
 *
 * All are 409. They are conflicts with the resource's current state, not
 * malformed requests — the request itself is well-formed in every case.
 */

/** The target equals the current state: an honest no-op, not a silent success. */
export function assetOperationalStateUnchangedError(
  state: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_OPERATIONAL_STATE_UNCHANGED,
    message: `This asset is already in operational state ${state}.`,
    statusCode: 409,
  });
}

/**
 * The transition is not permitted by the PART-02 table. In practice this is a
 * return-to-service attempt: `IN_SERVICE` is never a legal target here.
 */
export function assetOperationalStateTransitionNotAllowedError(
  from: string,
  to: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_OPERATIONAL_STATE_TRANSITION_NOT_ALLOWED,
    message:
      to === 'IN_SERVICE'
        ? `Returning an asset to service is not available through this operation; ${from} cannot transition to IN_SERVICE here.`
        : `Asset operational state cannot change from ${from} to ${to}.`,
    statusCode: 409,
  });
}

/**
 * The Asset is RETIRED. SEPARATE from the generic BE-05E `ASSET_RETIRED`
 * error: this is the operational axis reporting that its own door is shut
 * because the lifecycle is terminal, and it must be diagnosable as such.
 * Reads still return the last persisted operational state.
 */
export function assetOperationalStateRetiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_OPERATIONAL_STATE_RETIRED,
    message:
      'A retired asset cannot change operational state; the master lifecycle is terminal.',
    statusCode: 409,
  });
}

/**
 * The caller's `expectedVersion` is stale: someone else moved this Asset's
 * operational state first. Carries the CURRENT canonical state as conflict
 * metadata, mirroring the BE-25I sync-conflict shape, so the client can reload
 * and re-apply rather than guess. The write did NOT happen.
 */
export function assetOperationalStateConflictError(
  expectedVersion: number,
  current: {
    operationalState: string;
    version: number;
  },
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_OPERATIONAL_STATE_CONFLICT,
    message:
      'The asset operational state changed since it was read; reload the current state and re-apply.',
    statusCode: 409,
    conflict: {
      code: ERROR_CODES.ASSET_OPERATIONAL_STATE_CONFLICT,
      expectedVersion,
      current,
      guidance: {
        action: 'reload',
        reloadEndpoint: 'getAssetOperationalState',
      },
    },
  });
}

/**
 * PART 03 — the Asset is already IN_SERVICE, and this command has nothing to
 * do.
 *
 * A deterministic rejection rather than a silent success: a governed safety
 * command must never report that it returned equipment to service when nothing
 * happened and nothing was authorized. The Asset is already in the state the
 * caller wanted, so the honest answer is a conflict that names the state.
 *
 * This is ALSO the replay answer. A repeated request carrying the pre-return
 * `expectedVersion` cannot perform a second transition: the first thing the
 * retry meets is this refusal (see the concurrency section of the service).
 * There is no idempotency key in this contract — the CAS token plus this
 * terminal result are what protect against a duplicate.
 */
export function assetOperationalStateAlreadyInServiceError(): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_OPERATIONAL_STATE_ALREADY_IN_SERVICE,
    message:
      'This asset is already in operational state IN_SERVICE; there is nothing to return to service.',
    statusCode: 409,
  });
}

/**
 * PART 03 — an unresolved SAFETY_RISK Asset Failure blocks the return.
 *
 * The gate reads BE-21C's canonical failure state for the SAME Asset; it does
 * not resolve anything, and it does not reinterpret the record. A blocking
 * failure must first be resolved through the existing BE-21C lifecycle by
 * someone holding `asset_failure.manage` — returning an Asset to service is
 * never allowed to quietly clear a hazard record.
 *
 * The failure exposes TWO safe facts and nothing else: how many records block,
 * and the canonical path to clear them. No failure ids, titles, categories, or
 * incident numbers are disclosed here — a caller who may not read those records
 * (no `asset_failure.read`) must not receive them from a safety gate.
 */
export function assetOperationalStateUnresolvedSafetyRiskError(
  blockingCount: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK,
    message: `This asset cannot return to service while ${blockingCount} unresolved SAFETY_RISK asset failure(s) remain.`,
    statusCode: 409,
    conflict: {
      code: ERROR_CODES.ASSET_OPERATIONAL_STATE_UNRESOLVED_SAFETY_RISK,
      blockingCount,
      guidance: {
        action: 'resolve_asset_failures',
        resource: 'asset-failures',
        operation: 'PATCH /asset-failures/{incidentId}',
        permission: 'asset_failure.manage',
      },
    },
  });
}
