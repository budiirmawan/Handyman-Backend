import { AppError, ERROR_CODES } from '../../shared/errors';

/** CR-HM-BE-07 RUN 1 — errors owned only by material-demand authority. */
export function handymanMaterialDemandNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_DEMAND_NOT_FOUND,
    message: 'Handyman material demand not found.',
    statusCode: 404,
  });
}

export function handymanMaterialDemandStateInvalidError(
  message = 'The material demand is not in a state that permits this command.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_DEMAND_STATE_INVALID,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialDemandIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_DEMAND_IDEMPOTENCY_CONFLICT,
    message:
      'The idempotency key was already used with different material demand facts.',
    statusCode: 409,
  });
}

export function handymanMaterialDemandContextInvalidError(
  message = 'The material demand does not match its authoritative job context.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_DEMAND_CONTEXT_INVALID,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialAddendumNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_ADDENDUM_NOT_FOUND,
    message: 'Handyman material commercial addendum not found.',
    statusCode: 404,
  });
}

export function handymanMaterialAddendumStateInvalidError(
  message = 'The material commercial addendum is not in a state that permits this command.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_ADDENDUM_STATE_INVALID,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialAddendumIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_ADDENDUM_IDEMPOTENCY_CONFLICT,
    message:
      'The idempotency key was already used with different material addendum facts.',
    statusCode: 409,
  });
}

export function handymanMaterialAddendumPriceUnresolvedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_ADDENDUM_PRICE_UNRESOLVED,
    message:
      'An additional provider-stock material requires one matched authoritative price-catalog entry.',
    statusCode: 409,
  });
}

export function handymanMaterialApprovalNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_APPROVAL_NOT_FOUND,
    message: 'Handyman material approval not found.',
    statusCode: 404,
  });
}

export function handymanMaterialApprovalNotPendingError(
  message = 'The material approval is no longer pending.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_APPROVAL_NOT_PENDING,
    message,
    statusCode: 409,
  });
}

export function handymanMaterialApprovalNotAuthorizedError(
  message = 'The actor is not authorized to make this material approval decision.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_APPROVAL_NOT_AUTHORIZED,
    message,
    statusCode: 403,
  });
}

export function handymanMaterialApprovalForInvalidError(
  message = 'The approved-for party is not valid for this handyman request context.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_APPROVAL_FOR_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanMaterialApprovalNotesRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_APPROVAL_NOTES_REQUIRED,
    message: 'Decision notes are required for an assisted material approval decision.',
    statusCode: 400,
  });
}

export function handymanMaterialApprovalIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_APPROVAL_IDEMPOTENCY_CONFLICT,
    message:
      'The idempotency key was already used with different material approval decision facts.',
    statusCode: 409,
  });
}
