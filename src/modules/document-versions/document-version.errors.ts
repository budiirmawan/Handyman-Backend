import { AppError, ERROR_CODES } from '../../shared/errors';

export function documentVersionNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_VERSION_NOT_FOUND, message: 'Document version not found.', statusCode: 404 });
}
export function documentNotFoundForVersionError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_NOT_FOUND, message: 'Document not found for versioning.', statusCode: 404 });
}
export function documentVersionInvalidSequenceError(): AppError {
  return new AppError({ code: ERROR_CODES.DOCUMENT_VERSION_INVALID_SEQUENCE, message: 'Document version sequence is invalid.', statusCode: 409 });
}
