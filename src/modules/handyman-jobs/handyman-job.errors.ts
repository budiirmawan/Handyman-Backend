import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-05 RUN 1 — Handyman job + assignment composition errors.
 *
 * Rules owned by OTHER authorities are deliberately NOT re-created here:
 * provider/vendor/building-relationship failures reuse the CR-HM-BE-02 and
 * BE-15A errors, crew/worker failures reuse the CR-HM-BE-04 and BE-06F/03C
 * errors, work order failures reuse the BE-08 errors, and access failures
 * reuse the BE-02G context-access error. These factories cover only the
 * Handyman job/composition rules this module owns.
 */

export function handymanJobNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_NOT_FOUND,
    message: 'Handyman job not found.',
    statusCode: 404,
  });
}

export function handymanJobRequestNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_REQUEST_NOT_APPROVED,
    message: 'The handyman request is not approved; no job can be created.',
    statusCode: 409,
  });
}

export function handymanJobQuotationNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_QUOTATION_NOT_APPROVED,
    message:
      'The handyman request has no approved quotation bound to an approved revision.',
    statusCode: 409,
  });
}

export function handymanJobAlreadyExistsError(
  message = 'A handyman job already exists for this request.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_ALREADY_EXISTS,
    message,
    statusCode: 409,
  });
}

export function handymanJobContextMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_CONTEXT_MISMATCH,
    message:
      'The handyman job client/building context does not match its request or work order.',
    statusCode: 400,
  });
}

export function handymanJobNotAssignableError(
  message = 'The handyman job is not in a pre-execution assignable state.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_NOT_ASSIGNABLE,
    message,
    statusCode: 409,
  });
}

export function handymanJobAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_ALREADY_ASSIGNED,
    message:
      'The handyman job already has an active provider and crew; use reassignment to change it.',
    statusCode: 409,
  });
}

export function handymanJobNotAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_NOT_ASSIGNED,
    message: 'The handyman job has no active provider and crew assignment.',
    statusCode: 409,
  });
}

export function handymanJobAssignmentStateInvalidError(
  message = 'The handyman job assignment state changed during this operation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_ASSIGNMENT_STATE_INVALID,
    message,
    statusCode: 409,
  });
}

export function handymanJobProviderClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_PROVIDER_CLIENT_MISMATCH,
    message: 'The handyman provider designation does not belong to the job client.',
    statusCode: 400,
  });
}

export function handymanJobCrewProviderMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_CREW_PROVIDER_MISMATCH,
    message: 'The handyman work crew does not belong to the selected provider.',
    statusCode: 400,
  });
}

export function handymanJobProviderServiceNotEligibleError(
  missingCount: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_JOB_PROVIDER_SERVICE_NOT_ELIGIBLE,
    message: `The provider is not eligible for ${missingCount} active request service(s) at the work order building.`,
    statusCode: 409,
  });
}
