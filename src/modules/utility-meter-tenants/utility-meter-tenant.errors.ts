import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18D — Tenant Meter error contract. */

export function utilityMeterTenantAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_TENANT_ASSIGNMENT_NOT_FOUND,
    message: 'Tenant meter assignment not found.',
    statusCode: 404,
  });
}

/**
 * The Meter already has an ACTIVE tenant assignment. Moving a Meter to a new
 * tenant is an explicit end-then-assign, so a second assignment is a conflict
 * rather than a silent overwrite that would lose the previous tenancy.
 */
export function utilityMeterTenantAssignmentAlreadyExistsError(
  message = 'This meter is already assigned to an active tenant. End that assignment first.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_TENANT_ASSIGNMENT_ALREADY_EXISTS,
    message,
    statusCode: 409,
  });
}

/**
 * Cross-Client attempt: the Meter and the Tenant Company resolve to different
 * Clients. Reported as 400 rather than 404 so the caller learns the
 * combination is invalid without observing another Client's data.
 */
export function utilityMeterTenantClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_TENANT_CLIENT_MISMATCH,
    message: 'The meter and the tenant company must belong to the same client.',
    statusCode: 400,
  });
}

/**
 * The Space does not fit the assignment: either it sits in a different
 * Building than the Meter, or it is not leased by the given Tenant Company
 * according to the BE-14C tenant/space relationship.
 */
export function utilityMeterTenantSpaceMismatchError(
  message = 'The space does not belong to the meter building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_TENANT_SPACE_MISMATCH,
    message,
    statusCode: 400,
  });
}

/** An INACTIVE Meter, Tenant Company or Space cannot take an ACTIVE assignment. */
export function utilityMeterTenantContextUnavailableError(
  message = 'The meter, tenant company, or space is inactive.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_TENANT_CONTEXT_UNAVAILABLE,
    message,
    statusCode: 400,
  });
}
