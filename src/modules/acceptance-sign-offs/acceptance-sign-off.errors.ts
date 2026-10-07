import { AppError, ERROR_CODES } from '../../shared/errors';

export function acceptanceSignOffNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.ACCEPTANCE_SIGN_OFF_NOT_FOUND, message: 'Acceptance sign-off not found.', statusCode: 404 });
}
export function acceptanceInvalidContextError(message?: string): AppError {
  return new AppError({ code: ERROR_CODES.ACCEPTANCE_INVALID_CONTEXT, message: message ?? 'Acceptance sign-off context is invalid.', statusCode: 400 });
}
export function acceptanceUnauthorizedSignerError(): AppError {
  return new AppError({ code: ERROR_CODES.ACCEPTANCE_UNAUTHORIZED_SIGNER, message: 'Signer is not authorized for this building.', statusCode: 403 });
}
export function acceptanceInvalidDecisionError(): AppError {
  return new AppError({ code: ERROR_CODES.ACCEPTANCE_INVALID_DECISION, message: 'Decision must be ACCEPTED or REJECTED.', statusCode: 400 });
}
export function acceptanceDocumentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.ACCEPTANCE_DOCUMENT_NOT_FOUND, message: 'Target BAST or Handover document not found.', statusCode: 404 });
}
