import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanInspectorAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTOR_ASSIGNMENT_NOT_FOUND,
    message: 'No ACTIVE inspector assignment exists for this inspection visit.',
    statusCode: 404,
  });
}

export function handymanInspectorAssignmentIneligibleError(
  detail?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTOR_ASSIGNMENT_INELIGIBLE,
    message:
      'Proposed inspector is not eligible for this inspection visit.' +
      (detail ? ` ${detail}` : ''),
    statusCode: 409,
  });
}

export function handymanInspectorAssignmentConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTOR_ASSIGNMENT_CONFLICT,
    message:
      'An ACTIVE inspector assignment already exists; reassign instead.',
    statusCode: 409,
  });
}

export function handymanInspectorVisitInvalidError(detail: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTOR_ASSIGNMENT_VISIT_INVALID,
    message: `Inspection visit is not assignable: ${detail}`,
    statusCode: 409,
  });
}

export function handymanInspectorCapacityConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTOR_ASSIGNMENT_CAPACITY_CONFLICT,
    message:
      'Inspector is already reserved for an overlapping visit at this time.',
    statusCode: 409,
  });
}

export function handymanInspectorVersionConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTOR_ASSIGNMENT_VERSION_CONFLICT,
    message:
      'Inspector assignment version mismatch. Reload before retry.',
    statusCode: 409,
  });
}
