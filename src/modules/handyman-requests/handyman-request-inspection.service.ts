import { assertRequestOpen } from './handyman-prequotation-operations.service';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestInspectionRepository } from './handyman-request-inspection.repository';
import { assertAssignedFieldInspector } from './handyman-request-inspection-assignment.service';
import {
  handymanServiceRequestAlreadyInspectedError,
  handymanServiceRequestNotInspectionRequiredError,
} from './handyman-request-inspection.errors';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import {
  isHandymanInspectionResult,
  UNSUCCESSFUL_INSPECTION_REASONS,
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

  if ((input.inspectionResult === 'NOT_INSPECTABLE' && !UNSUCCESSFUL_INSPECTION_REASONS.includes(input.unsuccessfulReason!)) ||
      (input.inspectionResult === 'INSPECTED' && input.unsuccessfulReason != null)) {
    throw AppError.validation('Request validation failed.', [{ field: 'unsuccessfulReason', message: 'NOT_INSPECTABLE requires a structured reason; INSPECTED must not supply one.' }]);
  }
  if (input.evidenceSubmissionId != null && !isValidUuid(input.evidenceSubmissionId)) {
    throw AppError.validation('Request validation failed.', [{ field: 'evidenceSubmissionId', message: 'Must be a valid UUID.' }]);
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
      assertRequestOpen(request);

      // 2) Frozen F1 source-state gate: inspection only from INSPECTION_REQUIRED.
      if (request.status !== 'INSPECTION_REQUIRED') {
        throw handymanServiceRequestNotInspectionRequiredError();
      }

      // 3) Realm authority (CR-HM-SEC-01 PART 02): BE-02G building-scope
      //    guard over the request's own building_id (never caller-shaped
      //    context; no same-Client shortcut).
      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: request.clientId,
        buildingId: request.buildingId,
      });

      // 3b) CR-HM-INSPECTION-01 PART A — single-writer binding. For the
      //     in-scope inspection path the authenticated actor must BE the
      //     request's ACTIVE assigned Field inspector; the legacy generic
      //     `tenant_company.manage` route permission is no longer an
      //     alternative writer (fail closed when nothing is assigned).
      const assignment = await assertAssignedFieldInspector(tx, request.id, actorUserId);

      // 4) F2 pre-check inside the transaction; UNIQUE constrains races to
      //    the SAME 409 contract.
      const existing = await handymanRequestInspectionRepository
        .findByRequest(tx, request.id);
      const planned = (await tx.query<{ id: string; attempt_number: number; inspection_assignment_id: string }>(
        'SELECT id,attempt_number,inspection_assignment_id FROM handyman_inspection_revisit_attempts WHERE handyman_request_id=$1 ORDER BY attempt_number DESC LIMIT 1', [request.id])).rows[0];
      if (existing && (!planned || planned.attempt_number !== existing.attemptNumber+1 || planned.inspection_assignment_id !== assignment.id)) {
        throw handymanServiceRequestAlreadyInspectedError();
      }
      if (input.evidenceSubmissionId != null) {
        const evidence = await tx.query(`SELECT 1 FROM evidence_submissions WHERE id=$1 AND client_id=$2
          AND execution_type='HANDYMAN_REQUEST' AND execution_id=$3`, [input.evidenceSubmissionId, request.clientId, request.id]);
        if (!evidence.rowCount) throw AppError.validation('Request validation failed.', [{ field: 'evidenceSubmissionId', message: 'Evidence must belong to this exact request.' }]);
      }

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
          attemptNumber: existing ? existing.attemptNumber+1 : 1,
          revisitAttemptId: existing ? planned.id : null,
          inspectionAssignmentId: assignment.id,
          unsuccessfulReason: input.unsuccessfulReason ?? null,
          evidenceSubmissionId: input.evidenceSubmissionId ?? null,
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
            attemptNumber: record.attemptNumber,
            revisitAttemptId: record.revisitAttemptId,
            inspectionAssignmentId: assignment.id,
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
/**
 * Bounded read. CR-HM-03 PART 05A (FROZEN F8): with an authenticated
 * actor supplied (HTTP), the existing accessible-Client scope is enforced
 * server-side against the request-derived scope.
 */
export async function getHandymanRequestInspection(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<PublicHandymanRequestInspection> {
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
