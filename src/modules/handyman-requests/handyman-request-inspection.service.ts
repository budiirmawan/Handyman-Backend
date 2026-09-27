import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestInspectionRepository } from './handyman-request-inspection.repository';
import {
  handymanServiceRequestAlreadyInspectedError,
  handymanServiceRequestNotInspectionRequiredError,
} from './handyman-request-inspection.errors';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import {
  isHandymanInspectionResult,
  type CreateHandymanInspectionInput,
  type HandymanRequestInspectionRecord,
  type PublicHandymanRequestInspection,
} from './handyman-request-inspection.types';

/**
 * CR-HM-03 PART 02 — Handyman inspection record service
 * (FROZEN F1/F2/F3/F6/F7).
 *
 * Bounded transition: INSPECTION_REQUIRED → DIAGNOSIS. Exactly one
 * inspection record may exist per request (UNIQUE + pre-check, race-safe
 * 409; immutable/append-oriented trigger-enforced; no update/delete path).
 *
 * Authority (FROZEN F7): the explicit authenticated local user id is the
 * actor; it is NEVER derived or fabricated from tenantPicId, attribution,
 * or BM handoff identity. Client scope follows the existing
 * accessible-Client convention over the request-derived scope (403
 * BUILDING_ACCESS_DENIED); the record's context snapshot is always taken
 * verbatim from the authoritative request row — caller-supplied context
 * keys are structurally absent from input.
 *
 * FROZEN F3: this service creates NO evidence row, touches no evidence
 * vocabulary and leaves CR-HM-02 PART 04 PHOTO/VIDEO intake semantics
 * untouched (inspection evidence defers to CR-HM-10).
 *
 * NOT here (explicit FROZEN F1/governance): no diagnosis, no
 * classification, no specialist target/referral, no provider, no
 * checklist-template authoring, no quotation, no work-order/FM row,
 * no HTTP.
 */

/** UNIQUE constraint from 0381 for the race between concurrent inspectors. */
const INSPECTION_UNIQUE_CONSTRAINT = 'handyman_request_inspection_request_unique';

function isInspectionUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === INSPECTION_UNIQUE_CONSTRAINT
  );
}

function toPublic(
  record: HandymanRequestInspectionRecord,
): PublicHandymanRequestInspection {
  return { ...record, inspectedAt: record.inspectedAt.toISOString() };
}

/** Record the inspection and project the bounded F1 DIAGNOSIS state atomically. */
export async function recordHandymanInspection(
  input: CreateHandymanInspectionInput,
  actorUserId: string,
): Promise<PublicHandymanRequestInspection> {
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
  if (!isHandymanInspectionResult(input.inspectionResult)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'inspectionResult',
        message: `inspectionResult must be one of: ${
          ['INSPECTED', 'NOT_INSPECTABLE'].join(', ')
        }.`,
      },
    ]);
  }
  const inspectionNotes =
    typeof input.inspectionNotes === 'string'
      ? input.inspectionNotes.trim()
      : '';
  if (inspectionNotes.length < 1 || inspectionNotes.length > 1000) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'inspectionNotes',
        message: 'inspectionNotes is required (1-1000 characters).',
      },
    ]);
  }

  try {
    return await withTransaction(async (tx) => {
      // 1) Lock the parent for the decision chain (atomic series with
      //    steps 3–6; FOR UPDATE serializes concurrent inspectors).
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();

      // 2) Frozen F1 source-state gate: inspection only from INSPECTION_REQUIRED.
      if (request.status !== 'INSPECTION_REQUIRED') {
        throw handymanServiceRequestNotInspectionRequiredError();
      }

      // 3) Realm authority: existing accessible-Client convention over the
      //    request-derived scope (never caller-shaped context).
      if (
        !(await contextAccessService.canAccessClient(
          actorUserId,
          request.clientId,
        ))
      ) {
        throw buildingAccessDeniedError();
      }

      // 4) F2 pre-check inside the transaction; UNIQUE constrains races to
      //    the SAME 409 contract.
      const existing = await handymanRequestInspectionRepository
        .findByRequest(tx, request.id);
      if (existing) throw handymanServiceRequestAlreadyInspectedError();

      // 5) Append the minimum structured inspection record (0378-style
      //    verbatim context snapshot; the row IS the authoritative record).
      const record = await handymanRequestInspectionRepository
        .insertInspection(tx, {
          clientId: request.clientId,
          handymanRequestId: request.id,
          channelAttributionId: request.channelAttributionId,
          buildingId: request.buildingId,
          inspectionResult: input.inspectionResult,
          inspectionNotes,
          inspectedByUserId: actorUserId,
        });

      // 6) Bounded F1 projection: INSPECTION_REQUIRED → DIAGNOSIS.
      const projected = await handymanServiceRequestRepository.updateStatus(
        tx,
        request.id,
        'DIAGNOSIS',
      );
      if (!projected) throw handymanServiceRequestNotFoundError();

      // 7) FROZEN F6 journal row on the shared append-only authority —
      //    SAME executor (one atomic commit with steps 5–6). History only.
      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: 'HANDYMAN_INSPECTION_RECORDED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: `Handyman inspection recorded: ${input.inspectionResult}.`,
          metadata: {
            inspectionId: record.id,
            inspectionResult: input.inspectionResult,
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isInspectionUniqueViolation(error)) {
      throw handymanServiceRequestAlreadyInspectedError();
    }
    throw error;
  }
}

/** Bounded read of the F2 inspection record for one request. */
export async function getHandymanRequestInspection(
  handymanRequestId: string,
): Promise<PublicHandymanRequestInspection> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const record = await handymanRequestInspectionRepository.findByRequest(
    undefined,
    handymanRequestId,
  );
  if (!record) {
    throw AppError.notFound('Handyman request inspection record not found.');
  }
  return toPublic(record);
}

export const handymanServiceRequestInspectionService = {
  recordHandymanInspection,
  getHandymanRequestInspection,
};
