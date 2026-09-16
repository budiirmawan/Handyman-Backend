import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-03 RUN 2 — Customer quotation governance errors.
 *
 * Foundation errors stay with their owners (HANDYMAN_REQUEST_NOT_FOUND /
 * HANDYMAN_REQUEST_STATUS_INVALID from CR-HM-BE-01, SERVICE_CATALOG_* from
 * CR-BE-SVC-01, INVENTORY_ITEM_NOT_FOUND, BUILDING_ACCESS_DENIED from
 * BE-02G). Only quotation-authority rules get dedicated codes here.
 */

export function handymanQuotationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_NOT_FOUND,
    message: 'Handyman quotation not found.',
    statusCode: 404,
  });
}

export function handymanQuotationNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_NUMBER_ALREADY_EXISTS,
    message: 'The generated quotation number collided; retry the command.',
    statusCode: 409,
  });
}

export function handymanQuotationIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_IDEMPOTENCY_CONFLICT,
    message:
      'The idempotency key was already used for a different quotation command.',
    statusCode: 409,
  });
}

export function handymanQuotationNotAllowedError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_NOT_ALLOWED,
    message:
      message ??
      'The handyman request is not in a lifecycle state that allows a quotation.',
    statusCode: 409,
  });
}

export function handymanQuotationStateInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_STATE_INVALID,
    message:
      message ??
      'The handyman quotation is not in a lifecycle state that allows this command.',
    statusCode: 409,
  });
}

export function handymanQuotationSendRevisionInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_SEND_REVISION_INVALID,
    message:
      'Only a SUBMITTED revision of this quotation can be sent and bound.',
    statusCode: 409,
  });
}

export function handymanQuotationRevisionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_REVISION_NOT_FOUND,
    message: 'Handyman quotation revision not found.',
    statusCode: 404,
  });
}

export function handymanQuotationRevisionStateInvalidError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_REVISION_STATE_INVALID,
    message:
      message ??
      'The quotation revision is not in a state that allows this command.',
    statusCode: 409,
  });
}

export function handymanQuotationRevisionDraftExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_REVISION_DRAFT_EXISTS,
    message:
      'A DRAFT revision already exists for this quotation; at most one DRAFT revision is governed.',
    statusCode: 409,
  });
}

export function handymanQuotationLinesRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_LINES_REQUIRED,
    message: 'A quotation revision needs at least one governed line.',
    statusCode: 409,
  });
}

export function handymanQuotationLineNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_LINE_NOT_FOUND,
    message: 'Handyman quotation line not found.',
    statusCode: 404,
  });
}

export function handymanQuotationLineInvalidError(message: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_LINE_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanQuotationLineServiceNotSelectedError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_LINE_SERVICE_NOT_SELECTED,
    message:
      message ??
      'A LABOR line must reference a service with an ACTIVE governed selection on this handyman request.',
    statusCode: 409,
  });
}

export function handymanQuotationPriceUnresolvedError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_PRICE_UNRESOLVED,
    message:
      message ??
      'The reference price could not be resolved; the line fails closed.',
    statusCode: 409,
  });
}

export function handymanQuotationPriceDeviationNoteRequiredError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_PRICE_DEVIATION_NOTE_REQUIRED,
    message:
      message ??
      'A deviation note is mandatory when the authored price differs from the reference price or when no reference price exists.',
    statusCode: 400,
  });
}
