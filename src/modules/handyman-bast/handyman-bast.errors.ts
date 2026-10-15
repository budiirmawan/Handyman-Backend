import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanBastNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_NOT_FOUND,
    message: 'Handyman BAST not found.',
    statusCode: 404,
  });
}

/**
 * CR-HM-BAST-HTTP-01 — worker BAST transport: the caller is not the CURRENT
 * authoritative Crew Lead of the execution scope's active assignment (or no
 * active assignment resolves a Lead at all). Never granted by login, persona
 * name, or the permission alone.
 */
export function handymanBastNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_NOT_AUTHORIZED,
    message:
      'Actor is not the authorized worker (CURRENT Crew Lead) for this execution scope.',
    statusCode: 403,
  });
}

/**
 * CR-HM-BAST-HTTP-01 — optimistic concurrency guard: the caller's
 * expectedVersion does not match the artifact version derived from the
 * authoritative current status.
 */
export function handymanBastVersionConflictError(
  expectedVersion: number,
  actualVersion: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_VERSION_CONFLICT,
    message: 'Handyman BAST version conflict.',
    statusCode: 409,
    details: [
      `expectedVersion=${expectedVersion}`,
      `actualVersion=${actualVersion}`,
    ],
  });
}

export function handymanBastScopeNotEligibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_SCOPE_NOT_ELIGIBLE,
    message:
      'Handyman execution scope is not authorized for BAST issue.',
    statusCode: 409,
  });
}

export function handymanBastIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_ILLEGAL_TRANSITION,
    message: 'Illegal Handyman BAST transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanBastSignOffReservedError(action: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_SIGN_OFF_RESERVED,
    message:
      'Customer ACCEPT/REJECT is reserved for CR-HM-11 PART 02.',
    statusCode: 409,
    details: [`action=${action}`],
  });
}

export function handymanBastSignatureRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_SIGNATURE_REQUIRED,
    message:
      'Customer ACCEPT requires a signature digest bound to the BAST.',
    statusCode: 400,
  });
}

export function handymanBastActiveConflictError(
  executionScopeId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_ACTIVE_CONFLICT,
    message:
      'An active (non-VOID) Handyman BAST already exists for this execution scope.',
    statusCode: 409,
    details: [`executionScopeId=${executionScopeId}`],
  });
}

export function handymanBastValidationError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_VALIDATION,
    message: 'Invalid Handyman BAST input.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}

export function handymanBastQcNotReadyError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BAST_QC_NOT_READY,
    message: 'BAST PREPARE/ISSUE/ACCEPT requires the latest versioned Supervisor QC PASS with completed Work Sessions, resolved defects and verified QC bytes.',
    statusCode: 409,
  });
}
