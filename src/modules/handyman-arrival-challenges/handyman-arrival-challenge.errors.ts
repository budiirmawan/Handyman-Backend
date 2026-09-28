import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * Actor gate breach: not the authoritative current Lead for the
 * scope's ACTIVE assignment (covers: no ACTIVE assignment, invalid
 * Lead chain, actor != Lead user). Bounded, non-enumerating shape —
 * the three cases deliberately share ONE failure (governance §D/§F).
 */
export function arrivalChallengeNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_CHALLENGE_NOT_AUTHORIZED,
    message:
      'Only the authoritative current Lead of the execution scope ' +
      'crew assignment may create an arrival challenge.',
    statusCode: 403,
  });
}

/** Scope exists but is not AUTHORIZED (authority-state precondition). */
export function arrivalChallengeScopeNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_CHALLENGE_SCOPE_NOT_AUTHORIZED,
    message:
      'Arrival challenges require an execution scope with status ' +
      'AUTHORIZED.',
    statusCode: 409,
  });
}

/** Challenge id unknown (or bound to a different actor/scope). */
export function arrivalChallengeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_CHALLENGE_NOT_FOUND,
    message: 'Arrival challenge not found.',
    statusCode: 404,
  });
}

/** A live (unexpired PENDING) challenge already exists for the pair. */
export function arrivalChallengeLiveConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_CHALLENGE_LIVE_CONFLICT,
    message:
      'A live PENDING arrival challenge already exists for this ' +
      'execution scope and actor; consume it or let it expire.',
    statusCode: 409,
  });
}

/**
 * Generic fail-closed consumption failure: wrong token, replayed
 * CONSUMED/EXPIRED challenge, or live expiry reached. All cases share
 * ONE shape (non-enumerating, governance §F); server-side expiry is
 * projected before the failure is raised.
 */
export function arrivalChallengeInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_CHALLENGE_INVALID,
    message: 'Arrival challenge is not consumable.',
    statusCode: 409,
  });
}
