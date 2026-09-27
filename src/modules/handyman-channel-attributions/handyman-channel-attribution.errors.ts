import { AppError, ERROR_CODES } from '../../shared/errors';

/** CR-HM-01 PART 01 — Handyman Channel Attribution errors. */

export function handymanChannelAttributionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHANNEL_ATTRIBUTION_NOT_FOUND,
    message: 'Handyman channel attribution not found.',
    statusCode: 404,
  });
}

export function handymanChannelAttributionContextInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHANNEL_ATTRIBUTION_CONTEXT_INVALID,
    message:
      'An active tenant company and tenant building context for this building are required.',
    statusCode: 400,
  });
}

export function handymanChannelAttributionRequesterInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHANNEL_ATTRIBUTION_REQUESTER_INVALID,
    message: 'The customer must be an active PIC of the tenant company.',
    statusCode: 400,
  });
}

export function handymanChannelAttributionSpaceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH,
    message:
      'The space must have an active relationship to the tenant in this building.',
    statusCode: 400,
  });
}

export function handymanChannelAttributionOriginReferenceConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_CONFLICT,
    message:
      'This origin reference is already bound to an existing channel attribution.',
    statusCode: 409,
  });
}
