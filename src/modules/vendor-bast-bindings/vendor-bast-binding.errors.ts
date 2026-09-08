import { AppError, ERROR_CODES } from '../../shared/errors';

export function bastNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_NOT_FOUND,
    message: 'BAST binding not found.',
    statusCode: 404,
  });
}

/** The same Vendor Work already has a BAST binding. */
export function bastAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_ALREADY_EXISTS,
    message: 'A BAST already exists for this vendor work.',
    statusCode: 409,
  });
}

/** The BAST number is already taken within the Client. */
export function bastNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_NUMBER_ALREADY_EXISTS,
    message: 'A BAST with this number already exists for the client.',
    statusCode: 409,
  });
}

/**
 * The Work Order's Building does not match the Vendor Work's Building, or a
 * Vendor / Building filter combination is invalid.
 */
export function bastBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_BUILDING_MISMATCH,
    message: 'The work order building does not match the vendor work building.',
    statusCode: 400,
  });
}

/** The linked Completion Report does not belong to the same Vendor Work. */
export function bastCompletionMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_COMPLETION_MISMATCH,
    message: 'The completion report does not belong to this vendor work.',
    statusCode: 400,
  });
}

/** The linked Service Report does not belong to the same Vendor Work. */
export function bastServiceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_SERVICE_MISMATCH,
    message: 'The service report does not belong to this vendor work.',
    statusCode: 400,
  });
}

/** The requested acceptance transition is not allowed. */
export function bastInvalidTransitionError(
  from: string,
  to: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_INVALID_TRANSITION,
    message: `BAST cannot transition from ${from} to ${to}.`,
    statusCode: 400,
  });
}

/**
 * A deprecated legacy write cannot safely delegate to canonical BE-22.
 * Conflict is deliberate: callers must reconcile/use the canonical endpoint.
 */
export function bastLegacyWriteRestrictedError(
  action: 'create' | 'lifecycle',
  guidance: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_LEGACY_WRITE_RESTRICTED,
    message: `Legacy Vendor BAST ${action} writes are deprecated. ${guidance}`,
    statusCode: 409,
    conflict: {
      authority: 'BAST_DOCUMENT',
      retryable: false,
      guidance,
    },
  });
}
