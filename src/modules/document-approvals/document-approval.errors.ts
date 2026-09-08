import { AppError, ERROR_CODES } from '../../shared/errors';

export function documentApprovalNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_APPROVAL_NOT_FOUND, message: 'Document approval not found.', statusCode: 404 });
}
export function documentApprovalAlreadyPendingError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_APPROVAL_ALREADY_PENDING, message: 'Document approval already pending.', statusCode: 409 });
}
export function documentApprovalAlreadyDecidedError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_APPROVAL_ALREADY_DECIDED, message: 'Document approval already decided.', statusCode: 409 });
}
export function documentApprovalUnauthorizedError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_APPROVAL_UNAUTHORIZED, message: 'Approver is not authorized.', statusCode: 403 });
}
export function documentApprovalContextInvalidError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_APPROVAL_CONTEXT_INVALID, message: 'Document approval context is invalid.', statusCode: 400 });
}
export function documentApprovalFinalProtectedError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_APPROVAL_FINAL_PROTECTED, message: 'Final decision cannot be overwritten.', statusCode: 409 });
}
