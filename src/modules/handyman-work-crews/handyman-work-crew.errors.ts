import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-04 RUN 1 — Handyman Work Crew errors.
 *
 * Reuses the existing foundation errors wherever the violated rule belongs
 * to another authority:
 * - CLIENT_NOT_FOUND / CLIENT_INACTIVE (BE-02A `clients`)
 * - BUILDING_ACCESS_DENIED (BE-02G `contextAccessService`)
 * - VENDOR_NOT_FOUND / VENDOR_INACTIVE (BE-06A `vendors`)
 * - HANDYMAN_PROVIDER_NOT_FOUND / HANDYMAN_PROVIDER_STATUS_INVALID
 *   (CR-HM-BE-02 designation authority)
 * - VENDOR_WORKFORCE_BINDING_NOT_FOUND (BE-06F)
 * - WORKFORCE_PROFILE_INACTIVE (BE-03C), WORKFORCE_NOT_EXTERNAL (BE-03H),
 *   VENDOR_WORKFORCE_CLIENT_MISMATCH (BE-06F same-client rule)
 *
 * Only crew-composition rules get dedicated codes here.
 */

export function handymanWorkCrewNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_NOT_FOUND,
    message: 'Handyman work crew not found.',
    statusCode: 404,
  });
}

export function handymanWorkCrewProviderClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_PROVIDER_CLIENT_MISMATCH,
    message:
      'The handyman provider designation does not belong to the specified client.',
    statusCode: 400,
  });
}

export function handymanWorkCrewCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_CODE_ALREADY_EXISTS,
    statusCode: 409,
    message:
      'An active work crew with this crew code already exists for this handyman provider.',
  });
}

export function handymanWorkCrewStatusInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_STATUS_INVALID,
    message:
      message ??
      'The handyman work crew is not in the expected status for this transition.',
    statusCode: 400,
  });
}

/**
 * An operational ACTIVE crew must never exist with zero ACTIVE leads:
 * creation requires the founding Lead Worker, and reactivation re-asserts a
 * valid active lead. (A uniqueness index guarantees AT MOST one active lead;
 * only the lifecycle authority can guarantee AT LEAST one.)
 */
export function handymanWorkCrewLeadRequiredError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_LEAD_REQUIRED,
    message:
      message ??
      'An active handyman work crew requires an active lead worker.',
    statusCode: 400,
  });
}

export function handymanWorkCrewLeadAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_LEAD_ALREADY_ACTIVE,
    message:
      'This handyman work crew already has an active lead worker; use the change-lead command to replace it atomically.',
    statusCode: 409,
  });
}

export function handymanWorkCrewLeadRemovalForbiddenError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_LEAD_REMOVAL_FORBIDDEN,
    message:
      'The active lead worker of an active handyman work crew cannot be removed; use the change-lead command to replace the lead atomically.',
    statusCode: 409,
  });
}

export function handymanWorkCrewMemberNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_MEMBER_NOT_FOUND,
    message: 'Handyman work crew member not found.',
    statusCode: 404,
  });
}

export function handymanWorkCrewMemberAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_MEMBER_ALREADY_ACTIVE,
    message:
      'This vendor workforce binding already holds an active membership on this handyman work crew.',
    statusCode: 409,
  });
}

export function handymanWorkCrewMemberStatusInvalidError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_MEMBER_STATUS_INVALID,
    message:
      message ??
      'The handyman work crew membership is not in the expected status for this transition.',
    statusCode: 400,
  });
}

export function handymanWorkCrewWorkerBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_WORKER_BINDING_INACTIVE,
    message: 'The vendor workforce binding is not active.',
    statusCode: 409,
  });
}

export function handymanWorkCrewWorkerProviderMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_CREW_WORKER_PROVIDER_MISMATCH,
    message:
      'The vendor workforce binding does not belong to the crew handyman provider vendor.',
    statusCode: 400,
  });
}
