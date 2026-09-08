import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isWorkOrderAssigneeType,
  isWorkOrderAssignmentStatus,
  WORK_ORDER_ASSIGNEE_TYPES,
  WORK_ORDER_ASSIGNMENT_STATUSES,
  type AssignWorkOrderInput,
  type UpdateWorkOrderAssignmentInput,
  type WorkOrderAssigneeType,
} from './work-order-assignment.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workOrderId',
        message: 'Work order id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseAssignmentIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'assignmentId',
        message: 'Assignment id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/**
 * Parses an assignment payload (`POST /work-orders/:id/assignments` and the
 * reassign form of `PATCH`). The assignee fields required depend on
 * `assigneeType`; extra/irrelevant fields are ignored rather than rejected.
 */
export function parseAssignWorkOrderBody(
  body: unknown,
): Omit<AssignWorkOrderInput, 'workOrderId' | 'assignedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const assigneeType = readAssigneeType(body.assigneeType, details);
  const workforceProfileId = readOptionalUuid(
    body.workforceProfileId,
    'workforceProfileId',
    details,
  );
  const teamId = readOptionalUuid(body.teamId, 'teamId', details);
  const vendorId = readOptionalUuid(body.vendorId, 'vendorId', details);

  if (assigneeType) {
    switch (assigneeType) {
      case 'WORKFORCE':
        if (!workforceProfileId) {
          details.push({
            field: 'workforceProfileId',
            message: 'workforceProfileId is required for a WORKFORCE assignment.',
          });
        }
        break;
      case 'TEAM':
        if (!teamId) {
          details.push({
            field: 'teamId',
            message: 'teamId is required for a TEAM assignment.',
          });
        }
        break;
      case 'VENDOR':
        if (!vendorId) {
          details.push({
            field: 'vendorId',
            message: 'vendorId is required for a VENDOR assignment.',
          });
        }
        break;
      case 'VENDOR_WORKFORCE':
        if (!vendorId) {
          details.push({
            field: 'vendorId',
            message: 'vendorId is required for a VENDOR_WORKFORCE assignment.',
          });
        }
        if (!workforceProfileId) {
          details.push({
            field: 'workforceProfileId',
            message:
              'workforceProfileId is required for a VENDOR_WORKFORCE assignment.',
          });
        }
        break;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    assigneeType: assigneeType ?? 'WORKFORCE',
    ...(workforceProfileId === undefined ? {} : { workforceProfileId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(vendorId === undefined ? {} : { vendorId }),
  };
}

/**
 * Parses a PATCH assignment body. Two forms are accepted:
 *   - `{ status: 'INACTIVE' }`           → deactivate the assignment
 *   - an assignee payload                → reassign the Work Order
 * Returns `null` for the deactivate form (the service reads `status`).
 */
export function parseUpdateAssignmentBody(
  body: unknown,
): { deactivate: boolean } | { reassign: Omit<AssignWorkOrderInput, 'workOrderId' | 'assignedByUserId'> } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.status !== undefined) {
    if (!isWorkOrderAssignmentStatus(body.status)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'status',
          message: `Status must be one of: ${WORK_ORDER_ASSIGNMENT_STATUSES.join(', ')}.`,
        },
      ]);
    }
    return { deactivate: body.status === 'INACTIVE' };
  }

  return { reassign: parseAssignWorkOrderBody(body) };
}

function readAssigneeType(
  value: unknown,
  details: ValidationDetail[],
): WorkOrderAssigneeType | undefined {
  if (!isWorkOrderAssigneeType(value)) {
    details.push({
      field: 'assigneeType',
      message: `Assignee type must be one of: ${WORK_ORDER_ASSIGNEE_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}
