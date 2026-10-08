import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';
import {
  handymanServiceRequestAlreadyTriagedError,
  handymanServiceRequestNotFoundError,
  handymanServiceRequestNotIntakeError,
} from './handyman-request-triage.errors';
import {
  isHandymanTriageDisposition,
  type CreateHandymanRequestTriageInput,
  type HandymanRequestTriageDecisionRecord,
  type PublicHandymanRequestTriage,
} from './handyman-request-triage.types';

/**
 * CR-HM-03 PART 01 — Handyman request triage service (FROZEN F1/F2/F6/F7).
 *
 * Bounded transition chain:
 *   INTAKE → TRIAGE → INSPECTION_REQUIRED | DIAGNOSIS
 *
 * Exactly one triage decision record exists per request (FROZEN F2 —
 * immutable, append-oriented; DB trigger + UNIQUE enforce this; no update
 * or delete pathway exists anywhere in this module).
 *
 * Atomicity (test-proven): the request row is locked FOR UPDATE inside
 * ONE `withTransaction` executor; the triage record INSERT, the bounded F1
 * status projection UPDATE, and the append-only journal row
 * (`recordOperationalEvent` — FROZEN F6 audit/history, never lifecycle
 * authority) all commit or roll back together. The journal carries no
 * secrets and no request payload snapshots — only decision facts
 * (ids + disposition), and the engine scrubs reserved keys.
 *
 * Actor (FROZEN F7): the service demands an explicit authenticated local
 * user id (`actorUserId`), validated as a real `users.id` — the actor is
 * NEVER derived or fabricated from tenantPicId, channel attribution, or
 * the BM handoff identity. Client scope follows the same server-side
 * convention as CR-HM-02 (accessible-Client over the request-derived
 * scope, 403 BUILDING_ACCESS_DENIED otherwise — request snapshot truth,
 * never caller-supplied context).
 *
 * NOT here (explicit FROZEN F3/F5 + frozen map): no diagnosis content, no
 * inspection record, no classification, no specialist/provider action, no
 * quotation, no work-order/FM row, no evidence expansion, no HTTP.
 */

/** Unique constraint from 0380 for the race between concurrent triagers. */
const TRIAGE_UNIQUE_CONSTRAINT = 'handyman_request_triage_request_unique';

function isTriageUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === TRIAGE_UNIQUE_CONSTRAINT
  );
}

function toPublic(
  record: HandymanRequestTriageDecisionRecord,
): PublicHandymanRequestTriage {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

/**
 * Record the F2 triage decision and project the bounded F1 disposition
 * state atomically. `actorUserId` is the explicit local user performing
 * the action (validated as a real backend user — never inferred).
 */
export async function recordHandymanRequestTriage(
  input: CreateHandymanRequestTriageInput,
  actorUserId: string,
): Promise<PublicHandymanRequestTriage> {
  if (!isValidUuid(input.handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (!isValidUuid(actorUserId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId must be a valid local user UUID.' },
    ]);
  }
  if (!isHandymanTriageDisposition(input.triageDisposition)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'triageDisposition',
        message: `triageDisposition must be one of: ${
          ['INSPECTION_REQUIRED', 'DIAGNOSIS'].join(', ')
        }.`,
      },
    ]);
  }
  const triageNote =
    typeof input.triageNote === 'string' ? input.triageNote.trim() : '';
  if (triageNote.length < 1 || triageNote.length > 500) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'triageNote',
        message: 'triageNote is required (1-500 characters).',
      },
    ]);
  }

  try {
    return await withTransaction(async (tx) => {
      // 1) Lock the parent for the whole decision chain (serializes this
      //    request's FIRST triage attempt against any concurrent one).
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();

      // 2) Frozen F1 source-state gate: a triage decision only from INTAKE.
      if (request.status !== 'INTAKE') {
        throw handymanServiceRequestNotIntakeError();
      }

      // 3) Realm authority (CR-HM-SEC-01 PART 02): BE-02G building-scope
      //    guard over the request's own building_id (the request snapshot —
      //    never caller input; no same-Client shortcut).
      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: request.clientId,
        buildingId: request.buildingId,
      });

      // 4) F2 pre-check inside the transaction (the UNIQUE constrains
      //    races); duplicates resolve to the SAME 409 contract.
      const existing = await handymanRequestTriageRepository.findByRequest(
        tx,
        request.id,
      );
      if (existing) throw handymanServiceRequestAlreadyTriagedError();

      // 5) Append the decision record (0378-style verbatim context snapshot;
      //    the row IS the authoritative F2 record — no lifecycle authority).
      const record = await handymanRequestTriageRepository.insertDecision(tx, {
        clientId: request.clientId,
        handymanRequestId: request.id,
        channelAttributionId: request.channelAttributionId,
        buildingId: request.buildingId,
        triageDisposition: input.triageDisposition,
        triageNote,
        actorUserId,
      });

      // 6) Bounded F1 projection: status exactly = recorded disposition.
      const projected = await handymanServiceRequestRepository.updateStatus(
        tx,
        request.id,
        input.triageDisposition,
      );
      if (!projected) throw handymanServiceRequestNotFoundError();

      // 7) FROZEN F6 journal (shared BE-07 append-only authority; SAME
      //    executor ⇒ one atomic commit with steps 5–6). History/audit only.
      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: 'HANDYMAN_REQUEST_TRIAGED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: `Handyman request triage recorded: ${input.triageDisposition}.`,
          metadata: {
            triageDecisionId: record.id,
            triageDisposition: input.triageDisposition,
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isTriageUniqueViolation(error)) {
      throw handymanServiceRequestAlreadyTriagedError();
    }
    throw error;
  }
}

/** Bounded read of the F2 triage decision record for one request. */
/**
 * Bounded read. CR-HM-03 PART 05A (FROZEN F8): HTTP callers pass the
 * authenticated actor — the existing accessible-Client scope is then
 * enforced server-side against the request-derived scope, never from
 * caller-supplied context.
 */
export async function getHandymanRequestTriage(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<PublicHandymanRequestTriage> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (actorUserId !== undefined) {
    if (!isValidUuid(actorUserId)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'actorUserId', message: 'actorUserId must be a valid UUID.' },
      ]);
    }
    const request = await handymanServiceRequestRepository.findById(
      undefined,
      handymanRequestId,
    );
    if (!request) throw handymanServiceRequestNotFoundError();
    // CR-HM-SEC-01 PART 02: BE-02G building-scope guard over the
    // request's own building_id (no same-Client shortcut).
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });
  }
  const record = await handymanRequestTriageRepository.findByRequest(
    undefined,
    handymanRequestId,
  );
  if (!record) throw AppError.notFound('Handyman request triage record not found.');
  return toPublic(record);
}

export const handymanServiceRequestTriageService = {
  recordHandymanRequestTriage,
  getHandymanRequestTriage,
};
