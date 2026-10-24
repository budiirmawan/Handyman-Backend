import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { emitHandymanDomainNotificationIntent } from '../handyman-notifications/handyman-domain-notification.producer';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import { handymanRequestCancellationRepository } from './handyman-request-cancellation.repository';
import {
  handymanRequestAlreadyCancelledError,
  handymanRequestCancelCommittedError,
  handymanRequestCancelNotAllowedError,
  handymanRequestCancellationKeyConflictError,
} from './handyman-request-cancellation.errors';
import {
  isHandymanRequestCancellableStatus,
  type CancelHandymanRequestInput,
  type HandymanRequestCancellationRecord,
  type HandymanRequestCancellationResult,
  type PublicHandymanRequestCancellation,
} from './handyman-request-cancellation.types';

/**
 * CR-HM-18 REQUEST-CANCEL-01 — Handyman request cancellation (J01 closure).
 *
 * WHAT THIS OWNS
 * --------------
 * The single pre-commitment exit from the frozen CR-HM-03 request
 * vocabulary: a locked request in INTAKE / TRIAGE / INSPECTION_REQUIRED /
 * DIAGNOSIS / READY_FOR_NEXT_STEP becomes `CANCELLED`, and an append-only
 * cancellation fact records who/why/when plus the status observed.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No quotation, execution, dispatch or money state is touched: as soon as
 * the request owns an execution scope (an approved quotation), the command
 * fails closed with `HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED` and the
 * post-commitment authorities keep owning the ending. `REFERRED` is
 * already terminal and is never overwritten.
 *
 * AUTHORITY
 * ---------
 * Actor comes from `req.auth.userId` only. Realm authority is the BE-02G
 * exact-Building check on the locked request's authoritative
 * `{clientId, buildingId}` — there is no same-Client shortcut. Replays are
 * keyed by `idempotencyKey`: the same key with the same reason and actor
 * returns the original fact (`replayed: true`); anything else on an
 * already-cancelled request is a bounded 409.
 */

/**
 * Storage-level race mapping. Two concurrent cancellations of the SAME
 * request serialize on the parent row lock, but a reused idempotency key
 * across two DIFFERENT requests can still collide on the unique index; the
 * caller must see a bounded 409, never a raw 23505.
 */
function mapCancellationUniqueViolation(error: unknown): never {
  const candidate = error as { code?: string; constraint?: string } | undefined;
  if (candidate?.code === '23505') {
    if (
      candidate.constraint ===
      'handyman_request_cancellations_idempotency_key_key'
    ) {
      throw handymanRequestCancellationKeyConflictError();
    }
    if (
      candidate.constraint ===
      'handyman_request_cancellations_handyman_request_id_key'
    ) {
      throw handymanRequestAlreadyCancelledError();
    }
  }
  throw error;
}

function toPublic(
  record: HandymanRequestCancellationRecord,
): PublicHandymanRequestCancellation {
  return { ...record, occurredAt: record.occurredAt.toISOString() };
}

export async function cancelHandymanRequest(
  input: CancelHandymanRequestInput,
  actorUserId: string,
): Promise<HandymanRequestCancellationResult> {
  const details: { field: string; message: string }[] = [];
  if (!isValidUuid(input.handymanRequestId)) {
    details.push({
      field: 'handymanRequestId',
      message: 'handymanRequestId must be a valid UUID.',
    });
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > 500) {
    details.push({
      field: 'reason',
      message: 'reason is required (1-500 characters).',
    });
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    details.push({
      field: 'idempotencyKey',
      message: 'idempotencyKey is required (1-200 characters).',
    });
  }
  if (!isValidUuid(actorUserId)) {
    details.push({
      field: 'actorUserId',
      message: 'actorUserId must be a valid local user UUID.',
    });
  }
  if (details.length) throw AppError.validation('Request validation failed.', details);

  return withTransaction(async (tx) => {
    // 1) Lock the parent so two cancellations cannot race the projection.
    const request = await handymanServiceRequestRepository.lockById(
      tx,
      input.handymanRequestId,
    );
    if (!request) throw handymanServiceRequestNotFoundError();

    // 2) Realm authority on the locked request (404 before this wall).
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });

    // 3) Replay / double-cancel contract.
    const existing = await handymanRequestCancellationRepository.findByRequest(
      tx,
      request.id,
    );
    if (existing) {
      const sameIntent =
        existing.idempotencyKey === idempotencyKey &&
        existing.cancelledByUserId === actorUserId &&
        existing.reason === reason;
      if (sameIntent) {
        return {
          ...toPublic(existing),
          requestStatus: 'CANCELLED' as const,
          replayed: true,
        };
      }
      throw handymanRequestAlreadyCancelledError();
    }
    if (request.status === 'CANCELLED') {
      throw handymanRequestAlreadyCancelledError();
    }

    // 4) Frozen state rule: terminal REFERRED never becomes CANCELLED.
    if (!isHandymanRequestCancellableStatus(request.status)) {
      throw handymanRequestCancelNotAllowedError();
    }

    // 5) Commitment gate: an execution scope means an approved quotation.
    if (
      await handymanRequestCancellationRepository.requestHasExecutionScope(
        tx,
        request.id,
      )
    ) {
      throw handymanRequestCancelCommittedError();
    }

    // 5b) An idempotency key identifies exactly ONE intent. If the key is
    // already bound to another request's cancellation, fail closed instead
    // of surfacing a storage unique-violation.
    if (
      await handymanRequestCancellationRepository.findByIdempotencyKey(
        tx,
        idempotencyKey,
      )
    ) {
      throw handymanRequestCancellationKeyConflictError();
    }

    // 6) Append the fact, then project the terminal status.
    const record = await handymanRequestCancellationRepository
      .insertCancellation(tx, {
        clientId: request.clientId,
        handymanRequestId: request.id,
        channelAttributionId: request.channelAttributionId,
        buildingId: request.buildingId,
        previousStatus: request.status,
        reason,
        cancelledByUserId: actorUserId,
        idempotencyKey,
      })
      .catch((error: unknown) => mapCancellationUniqueViolation(error));
    await handymanServiceRequestRepository.updateStatus(
      tx,
      request.id,
      'CANCELLED',
    );

    // 7) Frozen audit journal row on the same executor.
    await recordOperationalEvent(
      {
        clientId: request.clientId,
        eventType: 'HANDYMAN_REQUEST_CANCELLED',
        entityType: 'HANDYMAN_SERVICE_REQUEST',
        entityId: request.id,
        actorUserId,
        buildingId: request.buildingId,
        summary: `Handyman request cancelled (was ${request.status}).`,
        metadata: {
          cancellationId: record.id,
          previousStatus: request.status,
          reason,
        },
      },
      tx,
    );

    // 7b) CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification
    // REACTION to the occurred cancellation, on the SAME transaction (so it
    // commits or rolls back with the cancellation). The audience stays the
    // declarative subscription rule; the tenant is the request's own client;
    // a notification configuration failure never fails the cancellation
    // command.
    await emitHandymanDomainNotificationIntent(
      {
        eventType: 'HANDYMAN_REQUEST_CANCELLED',
        clientId: request.clientId,
        entityId: record.id,
        buildingId: request.buildingId,
        variables: {
          handymanRequestId: request.id,
          cancellationId: record.id,
          previousStatus: request.status,
          reason,
          buildingId: request.buildingId,
        },
      },
      { executor: tx },
    );

    return {
      ...toPublic(record),
      requestStatus: 'CANCELLED' as const,
      replayed: false,
    };
  });
}

/** Bounded read of the append-only cancellation fact for one request. */
export async function getHandymanRequestCancellation(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanRequestCancellation> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (!isValidUuid(actorUserId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'actorUserId',
        message: 'actorUserId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });
  const record = await handymanRequestCancellationRepository.findByRequest(
    undefined,
    handymanRequestId,
  );
  if (!record) {
    throw AppError.notFound(
      'Handyman request cancellation record not found.',
    );
  }
  return toPublic(record);
}

export const handymanServiceRequestCancellationService = {
  cancelHandymanRequest,
  getHandymanRequestCancellation,
};
