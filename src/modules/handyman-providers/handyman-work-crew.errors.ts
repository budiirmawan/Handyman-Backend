import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanCrewNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_NOT_FOUND,
    message: 'Handyman work crew not found.',
    statusCode: 404,
  });
}

export function handymanCrewMemberNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_MEMBER_NOT_FOUND,
    message: 'No ACTIVE membership for that worker context in this crew.',
    statusCode: 404,
  });
}

/** Crew cannot be/become assignable without exactly one valid Lead (F4). */
export function handymanCrewLeadRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_LEAD_REQUIRED,
    message:
      'A Handyman work crew requires exactly one valid Lead Worker/PIC.',
    statusCode: 400,
  });
}

/** Lead candidate fails an F4 precondition (incl. NULL userId helper). */
export function handymanCrewLeadInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_LEAD_INVALID,
    message:
      'Lead must be an ACTIVE crew member with ACTIVE worker context ' +
      'under the same provider context and a non-null workforce userId.',
    statusCode: 400,
  });
}

/** The current Lead's membership cannot be deactivated while designated. */
export function handymanCrewLeadMembershipLockedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_LEAD_MEMBERSHIP_LOCKED,
    message:
      'The current Lead membership cannot be deactivated while designated Lead.',
    statusCode: 400,
  });
}

/** The worker context already has an ACTIVE membership in this crew (409). */
export function handymanCrewMemberAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_MEMBER_ALREADY_ACTIVE,
    message: 'This worker context already has an ACTIVE membership in this crew.',
    statusCode: 409,
  });
}

/** Crew/membership status vocabulary or same-state transition invalid. */
export function handymanCrewInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_INVALID_STATUS,
    message:
      'status must be ACTIVE or INACTIVE and must change the current state.',
    statusCode: 400,
  });
}

/** Crew code already used under this provider context (race-safe 409). */
export function handymanCrewCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CREW_CODE_ALREADY_EXISTS,
    message: 'A crew with this code already exists under this provider context.',
    statusCode: 409,
  });
}
