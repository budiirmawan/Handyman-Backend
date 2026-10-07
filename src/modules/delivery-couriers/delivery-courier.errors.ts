import { AppError, ERROR_CODES } from '../../shared/errors';

export function deliveryCourierNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_NOT_FOUND,
    message: 'Delivery / Courier record not found.',
    statusCode: 404,
  });
}

export function deliveryCourierContextRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_CONTEXT_REQUIRED,
    message: 'buildingId is required when no visit reference is supplied.',
    statusCode: 400,
  });
}

export function deliveryCourierVisitReferenceInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_VISIT_REFERENCE_INVALID,
    message: 'At most one of expectedVisitorId or walkInVisitId is allowed.',
    statusCode: 400,
  });
}

export function deliveryCourierContextMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_CONTEXT_MISMATCH,
    message:
      'The supplied Visitor or Building does not match the referenced visit.',
    statusCode: 400,
  });
}

export function deliveryCourierVisitCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_VISIT_CANCELLED,
    message: 'A cancelled visit cannot receive a Delivery / Courier context.',
    statusCode: 400,
  });
}

export function deliveryCourierAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_ALREADY_EXISTS,
    message: 'A Delivery / Courier context already exists for this visit.',
    statusCode: 409,
  });
}

export function deliveryCourierVisitorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_VISITOR_CLIENT_MISMATCH,
    message: 'The Visitor does not belong to the Building Client.',
    statusCode: 400,
  });
}

export function deliveryCourierVisitorNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_VISITOR_NOT_ACTIVE,
    message: 'The referenced Visitor must be ACTIVE.',
    statusCode: 400,
  });
}

export function deliveryCourierCourierRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_COURIER_REQUIRED,
    message: 'courierCompany or courierName is required.',
    statusCode: 400,
  });
}

export function deliveryCourierRecipientRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_RECIPIENT_REQUIRED,
    message: 'A recipient or host is required.',
    statusCode: 400,
  });
}

export function deliveryCourierRecipientUserNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_RECIPIENT_USER_NOT_ACTIVE,
    message: 'The recipient User must be ACTIVE.',
    statusCode: 400,
  });
}

export function deliveryCourierRecipientBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_RECIPIENT_BUILDING_MISMATCH,
    message: 'The recipient or host is not assigned to the Delivery Building.',
    statusCode: 400,
  });
}

export function deliveryCourierRecipientWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_RECIPIENT_WORKFORCE_INACTIVE,
    message: 'The recipient Workforce profile must be ACTIVE.',
    statusCode: 400,
  });
}

export function deliveryCourierRecipientWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_RECIPIENT_WORKFORCE_MISMATCH,
    message: 'The recipient Workforce profile does not belong to the Client.',
    statusCode: 400,
  });
}

export function deliveryCourierArrivalInFutureError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_ARRIVAL_IN_FUTURE,
    message: 'arrivedAt cannot be in the future.',
    statusCode: 400,
  });
}

export function deliveryCourierInvalidTransitionError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_INVALID_TRANSITION,
    message:
      'Only an ARRIVED Delivery / Courier record may transition to a terminal status.',
    statusCode: 409,
  });
}

export function deliveryCourierActiveVisitError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_ACTIVE_VISIT,
    message: 'A checked-in courier visit cannot be rejected or cancelled.',
    statusCode: 409,
  });
}

export function deliveryCourierNotActiveForCheckInError(): AppError {
  return new AppError({
    code: ERROR_CODES.DELIVERY_COURIER_NOT_ACTIVE_FOR_CHECK_IN,
    message: 'Only an ARRIVED Delivery / Courier context can be checked in.',
    statusCode: 409,
  });
}
