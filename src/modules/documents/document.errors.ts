import { AppError, ERROR_CODES } from '../../shared/errors';

export function documentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_NOT_FOUND,
    message: 'Document not found.',
    statusCode: 404,
  });
}

export function documentNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_NUMBER_ALREADY_EXISTS,
    message: 'Document number already exists for this client.',
    statusCode: 409,
  });
}

export function documentContextInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_CONTEXT_INVALID,
    message: message ?? 'Document context is invalid.',
    statusCode: 400,
  });
}

export function documentBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_BUILDING_MISMATCH,
    message: 'Building does not belong to the given client.',
    statusCode: 400,
  });
}

export function documentSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_SOURCE_NOT_FOUND,
    message: 'Document source not found.',
    statusCode: 404,
  });
}

export function documentSourceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_SOURCE_CLIENT_MISMATCH,
    message: 'Document source does not belong to the given client.',
    statusCode: 400,
  });
}

export function documentUpdateNotAllowedError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_UPDATE_NOT_ALLOWED,
    message: 'Document cannot be updated in its current status.',
    statusCode: 409,
  });
}

export function documentAlreadyArchivedError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_ALREADY_ARCHIVED,
    message: 'Document is already archived.',
    statusCode: 409,
  });
}

export function documentNotArchivedError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_NOT_ARCHIVED,
    message: 'Document is not archived.',
    statusCode: 409,
  });
}

export function documentRestoreNotAllowedError(): AppError {
  return new AppError({
    code: ERROR_CODES.DOCUMENT_RESTORE_NOT_ALLOWED,
    message: 'Document cannot be restored.',
    statusCode: 409,
  });
}
