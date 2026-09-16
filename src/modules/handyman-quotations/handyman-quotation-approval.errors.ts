import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-03 RUN 3 — Customer approval governance errors.
 *
 * Foundation errors stay with their owners (HANDYMAN_QUOTATION_* from Run 2,
 * HANDYMAN_REQUEST_STATUS_INVALID from CR-HM-BE-01, BUILDING_ACCESS_DENIED
 * from BE-02G). Only approval-authority rules get dedicated codes here.
 */

export function handymanQuotationApprovalNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_NOT_FOUND,
    message: 'Handyman quotation approval not found.',
    statusCode: 404,
  });
}

export function handymanQuotationApprovalNotPendingError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_NOT_PENDING,
    message:
      message ??
      'The approval decision is once-only; this approval is no longer PENDING.',
    statusCode: 409,
  });
}

export function handymanQuotationApprovalStateInvalidError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_STATE_INVALID,
    message:
      message ??
      'The quotation/approval/request lifecycle does not allow this approval command.',
    statusCode: 409,
  });
}

export function handymanQuotationApprovalAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_ALREADY_EXISTS,
    message:
      'A PENDING approval already exists for this quotation revision; at most one is governed.',
    statusCode: 409,
  });
}

export function handymanQuotationApprovalNotAuthorizedError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_NOT_AUTHORIZED,
    message:
      message ??
      'The actor is not the tenant PIC authorized for this handyman request.',
    statusCode: 403,
  });
}

export function handymanQuotationApprovalForInvalidError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_FOR_INVALID,
    message:
      message ??
      'The approved-for identity is not valid for this handyman request context.',
    statusCode: 400,
  });
}

export function handymanQuotationApprovalNotesRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_NOTES_REQUIRED,
    message: 'Decision notes are mandatory when recording an assisted approval decision.',
    statusCode: 400,
  });
}

export function handymanQuotationApprovalMethodUnsupportedError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_METHOD_UNSUPPORTED,
    message:
      message ??
      'The SECURE_LINK decision method is reserved; it is unreachable through the Run-3 decision runtime.',
    statusCode: 409,
  });
}

export function handymanQuotationApprovalLinkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_LINK_NOT_FOUND,
    message: 'Handyman quotation approval link not found.',
    statusCode: 404,
  });
}

export function handymanQuotationApprovalLinkStateInvalidError(
  message?: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_LINK_STATE_INVALID,
    message:
      message ??
      'The approval link is not in a state that allows this command.',
    statusCode: 409,
  });
}

export function handymanQuotationApprovalLinkAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_APPROVAL_LINK_ALREADY_ACTIVE,
    message:
      'An ACTIVE secure link already exists for this approval; revoke it before issuing a new one.',
    statusCode: 409,
  });
}
