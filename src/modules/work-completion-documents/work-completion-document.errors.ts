import { AppError, ERROR_CODES } from '../../shared/errors';

export function workCompletionDocumentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_COMPLETION_DOCUMENT_NOT_FOUND,
    message: 'Work completion document not found.',
    statusCode: 404,
  });
}

export function workCompletionWorkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_COMPLETION_WORK_NOT_FOUND,
    message: 'Work not found.',
    statusCode: 404,
  });
}

export function workCompletionWorkNotCompletedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_COMPLETION_WORK_NOT_COMPLETED,
    message: 'Work is not completed and cannot have a completion document.',
    statusCode: 400,
  });
}

export function workCompletionContextMismatchError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_COMPLETION_CONTEXT_MISMATCH,
    message: message ?? 'Work completion document context is invalid.',
    statusCode: 400,
  });
}

export function workCompletionBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_COMPLETION_BUILDING_MISMATCH,
    message: 'Building does not match work context.',
    statusCode: 400,
  });
}

export function workCompletionAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_COMPLETION_ALREADY_EXISTS,
    message: 'Work completion document already exists for this work.',
    statusCode: 409,
  });
}
