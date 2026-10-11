import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { AssignHandymanInspectionFieldInput } from '../handyman-requests';

/**
 * CR-HM-INSPECTION-01 PART A — request/DTO parsing for the pre-quotation
 * Field inspection assignment surface.
 *
 * Validation-only: the service remains the sole authority for the inspection
 * path, the target's user/permission/scope eligibility, the single-active
 * rule and the supersession chain.
 *
 * Authority rule: bodies expose ONLY caller-owned inputs (`assignedFieldUserId`
 * and, on reassignment, `reassignmentReason`). Smuggled keys — actor,
 * client/building/channel context, status, assignment or supersession ids —
 * are structurally IGNORED: the parser never spreads the source object.
 */

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/** Path parameter authority: the Handyman request id in the URL. */
export function parseInspectionHandymanRequestIdParam(value: unknown): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    fail([
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  return (value as string).trim().toLowerCase();
}

export function parseInspectionAssignmentBody(
  body: unknown,
): Omit<AssignHandymanInspectionFieldInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];

  const assignedFieldUserId =
    typeof source.assignedFieldUserId === 'string' &&
    isValidUuid(source.assignedFieldUserId.trim())
      ? source.assignedFieldUserId.trim().toLowerCase()
      : undefined;
  if (!assignedFieldUserId) {
    details.push({
      field: 'assignedFieldUserId',
      message: 'assignedFieldUserId is required and must be a valid UUID.',
    });
  }

  let reassignmentReason: string | undefined;
  if (source.reassignmentReason !== undefined) {
    if (typeof source.reassignmentReason !== 'string') {
      details.push({
        field: 'reassignmentReason',
        message: 'reassignmentReason must be a string.',
      });
    } else {
      const trimmed = source.reassignmentReason.trim();
      if (trimmed.length > 500) {
        details.push({
          field: 'reassignmentReason',
          message: 'reassignmentReason must be between 1 and 500 characters.',
        });
      } else if (trimmed.length > 0) {
        reassignmentReason = trimmed;
      }
    }
  }

  if (!assignedFieldUserId || details.length) fail(details);
  return { assignedFieldUserId, reassignmentReason };
}
