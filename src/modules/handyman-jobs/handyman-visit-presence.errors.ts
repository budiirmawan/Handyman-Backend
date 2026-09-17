import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-06 RUN 1 — Handyman visit crew presence errors.
 *
 * Rules owned by other authorities keep THEIR errors (visit/job guards,
 * crew/worker chain, BE-02G staff access). These factories cover only the
 * snapshot/presence-mark rules this module owns.
 */

/** No presence snapshot exists yet — the visit has no VERIFIED arrival. */
export function handymanVisitPresenceNotCapturedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_PRESENCE_NOT_CAPTURED,
    message:
      'No crew presence snapshot exists for this visit; a verified arrival is required first.',
    statusCode: 409,
  });
}

/**
 * The target binding is not a member of the visit's snapshot — arbitrary
 * worker ids can never be added to presence.
 */
export function handymanVisitPresenceMemberNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_PRESENCE_MEMBER_NOT_FOUND,
    message:
      'The vendor workforce binding is not a member of this visit presence snapshot.',
    statusCode: 404,
  });
}

export function handymanVisitPresenceStatusInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_PRESENCE_STATUS_INVALID,
    message: 'presenceStatus must be PRESENT or ABSENT.',
    statusCode: 400,
  });
}

/**
 * The authenticated field actor does not resolve through the governed lead
 * chain AGAINST THE SNAPSHOT (user → workforce profile → ACTIVE binding →
 * the snapshot's LEAD_WORKER row). IDs only — never worker PII.
 */
export function handymanVisitPresenceActorNotLeadError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_PRESENCE_ACTOR_NOT_LEAD,
    message:
      'The authenticated user does not resolve to the lead worker of this visit presence snapshot.',
    statusCode: 403,
  });
}

export function handymanVisitPresenceAssistedReasonRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_PRESENCE_ASSISTED_REASON_REQUIRED,
    message: 'assistedReason is required and must be a non-empty string.',
    statusCode: 400,
  });
}
