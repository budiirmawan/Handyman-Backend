import { AppError, ERROR_CODES } from '../../shared/errors';

export function toiletInspectionBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TOILET_INSPECTION_BINDING_NOT_FOUND,
    message: 'Toilet inspection binding not found.',
    statusCode: 404,
  });
}

export function toiletInspectionBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TOILET_INSPECTION_BINDING_ALREADY_EXISTS,
    message:
      'An active toilet inspection binding already exists for this cleaning area and checklist template.',
    statusCode: 409,
  });
}

export function toiletInspectionBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.TOILET_INSPECTION_BINDING_INACTIVE,
    message:
      'Inactive toilet inspection binding cannot start new checklist executions.',
    statusCode: 400,
  });
}

export function toiletInspectionTemplateClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.TOILET_INSPECTION_TEMPLATE_CLIENT_MISMATCH,
    message:
      'The checklist template does not belong to the cleaning area client.',
    statusCode: 400,
  });
}

export function toiletInspectionLocationMismatchError(
  message = 'The referenced location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.TOILET_INSPECTION_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function toiletInspectionExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TOILET_INSPECTION_EXECUTION_NOT_FOUND,
    message:
      'Checklist execution is not linked to a toilet inspection binding.',
    statusCode: 404,
  });
}
