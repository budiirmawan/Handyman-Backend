import { AppError, ERROR_CODES } from '../../shared/errors';

export function publicAreaInspectionBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PUBLIC_AREA_INSPECTION_BINDING_NOT_FOUND,
    message: 'Public area inspection binding not found.',
    statusCode: 404,
  });
}

export function publicAreaInspectionBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PUBLIC_AREA_INSPECTION_BINDING_ALREADY_EXISTS,
    message:
      'An active public area inspection binding already exists for this cleaning area and checklist template.',
    statusCode: 409,
  });
}

export function publicAreaInspectionBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PUBLIC_AREA_INSPECTION_BINDING_INACTIVE,
    message:
      'Inactive public area inspection binding cannot start new checklist executions.',
    statusCode: 400,
  });
}

export function publicAreaInspectionTemplateClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PUBLIC_AREA_INSPECTION_TEMPLATE_CLIENT_MISMATCH,
    message:
      'The checklist template does not belong to the cleaning area client.',
    statusCode: 400,
  });
}

export function publicAreaInspectionLocationMismatchError(
  message = 'The referenced location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.PUBLIC_AREA_INSPECTION_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function publicAreaInspectionExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PUBLIC_AREA_INSPECTION_EXECUTION_NOT_FOUND,
    message:
      'Checklist execution is not linked to a public area inspection binding.',
    statusCode: 404,
  });
}
