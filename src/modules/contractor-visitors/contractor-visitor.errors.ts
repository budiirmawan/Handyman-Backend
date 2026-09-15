import { AppError, ERROR_CODES } from '../../shared/errors';

export function contractorVisitorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_NOT_FOUND,
    message: 'Contractor visitor context not found.',
    statusCode: 404,
  });
}

export function contractorVisitorVisitReferenceRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_VISIT_REFERENCE_REQUIRED,
    message:
      'Exactly one of expectedVisitorId or walkInVisitId is required.',
    statusCode: 400,
  });
}

export function contractorVisitorVisitMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_VISIT_MISMATCH,
    message:
      'The supplied Visitor or Building does not match the referenced visit.',
    statusCode: 400,
  });
}

export function contractorVisitorVisitCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_VISIT_CANCELLED,
    message: 'A cancelled visit cannot receive a contractor context.',
    statusCode: 400,
  });
}

export function contractorVisitorAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_ALREADY_EXISTS,
    message: 'A contractor context already exists for this visit.',
    statusCode: 409,
  });
}

export function contractorVisitorVisitorNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_VISITOR_NOT_ACTIVE,
    message: 'The visit Visitor must be ACTIVE.',
    statusCode: 400,
  });
}

export function contractorVisitorHostRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_HOST_REQUIRED,
    message: 'A responsible host or PIC is required.',
    statusCode: 400,
  });
}

export function contractorVisitorHostUserNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_HOST_USER_NOT_ACTIVE,
    message: 'The responsible host User must be ACTIVE.',
    statusCode: 400,
  });
}

export function contractorVisitorHostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_HOST_BUILDING_MISMATCH,
    message:
      'The responsible host or PIC is not actively assigned to the visit Building.',
    statusCode: 400,
  });
}

export function contractorVisitorHostWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_HOST_WORKFORCE_INACTIVE,
    message: 'The responsible host Workforce profile must be ACTIVE.',
    statusCode: 400,
  });
}

export function contractorVisitorHostWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_HOST_WORKFORCE_MISMATCH,
    message:
      'The responsible host Workforce profile does not belong to the visit Client.',
    statusCode: 400,
  });
}

export function contractorVisitorLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_LOCATION_BUILDING_MISMATCH,
    message:
      'The functional location does not belong to the visit Building.',
    statusCode: 400,
  });
}

export function contractorVisitorLocationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_LOCATION_INACTIVE,
    message: 'The functional location must be ACTIVE.',
    statusCode: 400,
  });
}

export function contractorVisitorAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_ALREADY_CANCELLED,
    message: 'A cancelled contractor context can no longer be updated.',
    statusCode: 409,
  });
}

export function contractorVisitorActiveVisitError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_ACTIVE_VISIT,
    message: 'A checked-in contractor context cannot be cancelled.',
    statusCode: 409,
  });
}

export function contractorVisitorCancelledCheckInError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONTRACTOR_VISITOR_CANCELLED_CHECK_IN,
    message: 'A cancelled contractor context cannot be checked in.',
    statusCode: 409,
  });
}
