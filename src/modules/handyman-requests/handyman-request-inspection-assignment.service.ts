import { assertRequestOpen } from './handyman-prequotation-operations.service';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';
import { handymanRequestInspectionAssignmentRepository as repository } from './handyman-request-inspection-assignment.repository';
import {
  handymanInspectionAssignmentNotEligibleError,
  handymanInspectionAssignmentRequiredError,
  handymanInspectionAssignmentTargetInvalidError,
  handymanInspectionFieldDeniedError,
  handymanInspectionReassignmentNotAllowedError,
  handymanInspectionReassignmentReasonRequiredError,
} from './handyman-request-inspection-assignment.errors';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import { isHandymanInspectionReassignmentAllowed } from './handyman-request-inspection-report.service';
import type {
  AssignHandymanInspectionFieldInput,
  HandymanInspectionAssignmentRecord,
  PublicHandymanInspectionAssignment,
  PublicHandymanInspectionAssignmentState,
} from './handyman-request-inspection-assignment.types';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment
 * service.
 *
 * Bounded to: the durable assignment/reassignment fact for a request whose
 * persisted triage disposition is INSPECTION_REQUIRED, and the bounded read
 * of that fact plus its supersession history.
 *
 * Authority (FROZEN F7): `assigned_field_user_id` is the existing
 * authenticated local user id — never a PIC, attribution, BM, provider,
 * crew or Lead identity. The request's client/building context is always
 * taken verbatim from the request row; caller-supplied context keys are
 * structurally absent from the input type.
 *
 * NOT here (explicit CR-HM-04 / CR-HM-06 boundaries): no Execution Scope,
 * no provider/crew assignment, no quotation, no price, no PIC approval, no
 * scheduling, no request-status change.
 */

/** Dedicated Field authority the assignment target must already hold. */
export const HANDYMAN_FIELD_REPORT_PERMISSION =
  'handyman.field.inspection.report.submit';

function isAssignmentUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    (candidate?.constraint ===
      'handyman_request_inspection_assignment_active_unique' ||
      candidate?.constraint ===
        'handyman_request_inspection_assignment_successor_unique' ||
      candidate?.constraint ===
        'handyman_request_inspection_assignment_predecessor_unique')
  );
}

function toPublic(
  record: HandymanInspectionAssignmentRecord,
): PublicHandymanInspectionAssignment {
  return {
    ...record,
    assignedAt: record.assignedAt.toISOString(),
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
  };
}

/**
 * The request must be on the inspection path: the persisted triage
 * disposition is the authority (never request JSON, never an audit event).
 */
async function assertInspectionPath(
  tx: PoolClient,
  handymanRequestId: string,
): Promise<void> {
  const triage = await handymanRequestTriageRepository.findByRequest(
    tx,
    handymanRequestId,
  );
  if (!triage || triage.triageDisposition !== 'INSPECTION_REQUIRED') {
    throw handymanInspectionAssignmentNotEligibleError();
  }
}

/**
 * Resolve the ACTIVE assignment of a request, or fail closed. Shared by the
 * assignment read/withdrawal surface and by the in-scope physical
 * inspection write (one writer, one assignment authority).
 */
export async function requireActiveHandymanInspectionAssignment(
  tx: PoolClient,
  handymanRequestId: string,
): Promise<HandymanInspectionAssignmentRecord> {
  const current = await repository.findActiveByRequest(tx, handymanRequestId);
  if (!current) throw handymanInspectionAssignmentRequiredError();
  return current;
}

/**
 * Assign (or reassign) the pre-quotation Field inspector.
 *
 * Reassignment is refused without a reason, is refused once a report
 * version is pending review or accepted, and never erases the predecessor
 * row: the predecessor is superseded with the reason and both directions of
 * the chain are persisted.
 */
export async function assignHandymanInspectionField(
  input: AssignHandymanInspectionFieldInput,
  actorUserId: string,
): Promise<PublicHandymanInspectionAssignmentState & { changed: boolean }> {
  if (!isValidUuid(input.handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (!isValidUuid(input.assignedFieldUserId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'assignedFieldUserId',
        message: 'assignedFieldUserId must be a valid local user UUID.',
      },
    ]);
  }
  if (!isValidUuid(actorUserId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'actorUserId',
        message: 'actorUserId must be a valid local user UUID.',
      },
    ]);
  }
  const reason =
    typeof input.reassignmentReason === 'string'
      ? input.reassignmentReason.trim()
      : '';
  if (reason.length > 500) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'reassignmentReason',
        message: 'reassignmentReason must be between 1 and 500 characters.',
      },
    ]);
  }

  try {
    return await withTransaction(async (tx) => {
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();

      await assertInspectionPath(tx, request.id);

      // Operations authority: the assigner passes the existing BE-02G
      // exact-Building guard over the request-derived context.
      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: request.clientId,
        buildingId: request.buildingId,
      });
      assertRequestOpen(request);

      // Target authority (FROZEN F7 + dedicated code): ACTIVE local user,
      // reporting permission held, exact-Building access already granted.
      const targetIsActive = await repository.isActiveUser(
        tx,
        input.assignedFieldUserId,
      );
      const targetHasPermission = await repository.hasActivePermission(
        tx,
        input.assignedFieldUserId,
        HANDYMAN_FIELD_REPORT_PERMISSION,
      );
      const targetHasBuilding = await repository.hasActiveBuildingAssignment(
        tx,
        input.assignedFieldUserId,
        request.buildingId,
      );
      if (!targetIsActive || !targetHasPermission || !targetHasBuilding) {
        throw handymanInspectionAssignmentTargetInvalidError();
      }

      const current = await repository.findActiveByRequest(tx, request.id);
      if (current && current.assignedFieldUserId === input.assignedFieldUserId) {
        // Same target: no new fact is created and the existing chain stands.
        const history = await repository.listByRequest(tx, request.id);
        return {
          current: toPublic(current),
          history: history.map(toPublic),
          changed: false,
        };
      }

      if (current) {
        if (reason.length < 1) {
          throw handymanInspectionReassignmentReasonRequiredError();
        }
        const reassignable = await isReassignmentAllowed(
          tx,
          request.id,
          current.id,
        );
        if (!reassignable) {
          throw handymanInspectionReassignmentNotAllowedError();
        }
      }

      const nextId = randomUUID();
      if (current) {
        await repository.supersedeAssignment(tx, {
          assignmentId: current.id,
          supersededByAssignmentId: nextId,
          reason,
        });
      }
      const record = await repository.insertAssignment(tx, {
        id: nextId,
        clientId: request.clientId,
        handymanRequestId: request.id,
        channelAttributionId: request.channelAttributionId,
        buildingId: request.buildingId,
        assignedFieldUserId: input.assignedFieldUserId,
        assignedByUserId: actorUserId,
        supersedesAssignmentId: current ? current.id : null,
        supersessionReason: null,
      });

      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: current
            ? 'HANDYMAN_INSPECTION_REASSIGNED'
            : 'HANDYMAN_INSPECTION_ASSIGNED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: current
            ? 'Handyman Field inspector reassigned.'
            : 'Handyman Field inspector assigned.',
          metadata: {
            assignmentId: record.id,
            assignedFieldUserId: record.assignedFieldUserId,
            ...(current ? { supersededAssignmentId: current.id } : {}),
          },
        },
        tx,
      );

      const history = await repository.listByRequest(tx, request.id);
      return {
        current: toPublic(record),
        history: history.map(toPublic),
        changed: true,
      };
    });
  } catch (error) {
    if (isAssignmentUniqueViolation(error)) {
      // A concurrent assignment write won the single-active/chain race; the
      // caller observes a controlled conflict and re-reads the winner.
      throw new AppError({
        code: ERROR_CODES.HANDYMAN_INSPECTION_ASSIGNMENT_CONFLICT,
        message:
          'A concurrent Field inspection assignment write already changed this request.',
        statusCode: 409,
      });
    }
    throw error;
  }
}

/**
 * Reassignment bound (safe default recorded in the CR-HM-INSPECTION-01
 * reconciliation): allowed before a report version exists and after a
 * `RETURNED` decision (so a correction may be produced by a replacement
 * Field user); refused while the latest version is pending review and after
 * ANY version has been accepted. The report chain belongs to the assignment
 * that produced it, and acceptance is terminal.
 */
async function isReassignmentAllowed(
  tx: PoolClient,
  handymanRequestId: string,
  _currentAssignmentId: string,
): Promise<boolean> {
  return isHandymanInspectionReassignmentAllowed(tx, handymanRequestId);
}

/** Bounded read: current assignment + immutable supersession history. */
export async function getHandymanInspectionAssignment(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<PublicHandymanInspectionAssignmentState> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (actorUserId !== undefined) {
    if (!isValidUuid(actorUserId)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'actorUserId', message: 'actorUserId must be a valid UUID.' },
      ]);
    }
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });
  }
  const history = await repository.listByRequest(undefined, request.id);
  const current = history.find((row) => row.status === 'ACTIVE') ?? null;
  return {
    current: current ? toPublic(current) : null,
    history: history.map(toPublic),
  };
}

/**
 * Fail-closed Field binding for the in-scope physical inspection write: the
 * authenticated actor must BE the active assigned Field user.
 */
export async function assertAssignedFieldInspector(
  tx: PoolClient,
  handymanRequestId: string,
  actorUserId: string,
): Promise<HandymanInspectionAssignmentRecord> {
  const current = await requireActiveHandymanInspectionAssignment(
    tx,
    handymanRequestId,
  );
  if (current.assignedFieldUserId !== actorUserId ||
      !(await repository.isActiveUser(tx, actorUserId)) ||
      !(await repository.hasActivePermission(tx, actorUserId, HANDYMAN_FIELD_REPORT_PERMISSION))) {
    throw handymanInspectionFieldDeniedError();
  }
  return current;
}

export const handymanRequestInspectionAssignmentService = {
  assignHandymanInspectionField,
  getHandymanInspectionAssignment,
};
