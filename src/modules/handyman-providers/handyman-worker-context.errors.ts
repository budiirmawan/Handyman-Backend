import { AppError, ERROR_CODES } from '../../shared/errors';

/** Worker context referenced but not resolvable. */
export function handymanWorkerContextNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORKER_CONTEXT_NOT_FOUND,
    message: 'Handyman worker context not found.',
    statusCode: 404,
  });
}

/** One context per (provider-context, profile) pair (race-safe 409). */
export function handymanWorkerContextAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORKER_CONTEXT_ALREADY_EXISTS,
    message:
      'This workforce profile already has a worker context under this provider context.',
    statusCode: 409,
  });
}

/** Status payload invalid or same-state. */
export function handymanWorkerContextInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORKER_CONTEXT_INVALID_STATUS,
    message:
      'status must be ACTIVE or INACTIVE and must change the current state.',
    statusCode: 400,
  });
}

/**
 * The workforce profile cannot participate under this provider: missing
 * ACTIVE provider context, wrong Client chain, or missing required
 * vendor↔workforce binding (never synthesized — F2/business model).
 */
export function handymanWorkforceBindingRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORKFORCE_BINDING_REQUIRED,
    message:
      'The workforce profile is not eligible under this provider context: ' +
      'an ACTIVE provider context and an ACTIVE vendor workforce binding ' +
      'within the request Client are required.',
    statusCode: 400,
  });
}
