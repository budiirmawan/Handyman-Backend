import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanDispatchNotReadyError(
  failures: string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DISPATCH_NOT_READY,
    message:
      'Execution scope is not dispatch-ready: ' + failures.join('; '),
    statusCode: 409,
    details: failures,
  });
}

export function handymanDispatchReleaseNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DISPATCH_RELEASE_NOT_FOUND,
    message: 'No active dispatch release found.',
    statusCode: 404,
  });
}

export function handymanDispatchReleaseConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DISPATCH_RELEASE_CONFLICT,
    message: `Dispatch release conflict: ${reason}`,
    statusCode: 409,
  });
}
