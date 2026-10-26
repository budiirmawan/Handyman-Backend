import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanUnlistedIntakeCaseNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_CASE_NOT_FOUND,
    message: 'Handyman unlisted service intake case not found.',
    statusCode: 404,
  });
}

export function handymanUnlistedIntakeForbiddenError(
  message = 'You are not authorized to access this unlisted service intake case.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_FORBIDDEN,
    message,
    statusCode: 403,
  });
}

export function handymanUnlistedIntakeIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency key has already been used with a different unlisted service intake payload.',
    statusCode: 409,
  });
}

export function handymanUnlistedIntakeImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_IMMUTABLE,
    message: 'Unlisted service intake case provenance and fields are immutable.',
    statusCode: 409,
  });
}

export function handymanUnlistedIntakeTriageAlreadyRecordedError(
  status: string,
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_TRIAGE_ALREADY_RECORDED,
    message:
      message ??
      'This unlisted service intake case has already been triaged by Operations; a second triage decision is not permitted.',
    statusCode: 409,
    details: [{ status }],
  });
}

export function handymanUnlistedIntakeTriageIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_TRIAGE_IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency key has already been used with a different triage decision payload.',
    statusCode: 409,
  });
}

export function handymanUnlistedIntakeTriageCatalogServiceInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_TRIAGE_CATALOG_SERVICE_INVALID,
    message:
      'catalogServiceId must reference an existing ACTIVE service_catalog entry of this case Client; no catalog entry is created by triage.',
    statusCode: 400,
  });
}

export function handymanUnlistedIntakeTriageUomInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_TRIAGE_UOM_INVALID,
    message: 'manualQuoteUomId must reference an existing ACTIVE unit of measure.',
    statusCode: 400,
  });
}
