import { AppError, ERROR_CODES } from '../../shared/errors';

export function supportingDocumentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.SUPPORTING_DOCUMENT_NOT_FOUND, message: 'Supporting document not found.', statusCode: 404 });
}
export function supportingDocumentParentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.SUPPORTING_DOCUMENT_PARENT_NOT_FOUND, message: 'Parent for supporting document not found.', statusCode: 404 });
}
export function supportingDocumentContextMismatchError(message?: string): AppError {
  return new AppError({ code: ERROR_CODES.SUPPORTING_DOCUMENT_CONTEXT_MISMATCH, message: message ?? 'Supporting document context is invalid.', statusCode: 400 });
}
export function supportingDocumentBuildingMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.SUPPORTING_DOCUMENT_BUILDING_MISMATCH, message: 'Supporting document building does not match parent.', statusCode: 400 });
}
export function supportingDocumentInvalidParentError(): AppError {
  return new AppError({ code: ERROR_CODES.SUPPORTING_DOCUMENT_INVALID_PARENT, message: 'Supporting document parent type is invalid.', statusCode: 400 });
}
