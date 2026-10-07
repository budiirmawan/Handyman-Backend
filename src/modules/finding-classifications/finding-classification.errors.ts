import { AppError, ERROR_CODES } from '../../shared/errors';

export function findingClassificationNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_CLASSIFICATION_NOT_FOUND, message: 'Finding classification not found.', statusCode: 404 });
}
export function findingClassificationCodeAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_CLASSIFICATION_CODE_ALREADY_EXISTS, message: 'A finding classification with this code already exists for this client.', statusCode: 409 });
}
export function findingClassificationInactiveError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_CLASSIFICATION_INACTIVE, message: 'Inactive finding classification cannot be assigned.', statusCode: 400 });
}
export function findingClassificationClientMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_CLASSIFICATION_CLIENT_MISMATCH, message: 'Finding classification belongs to another client.', statusCode: 400 });
}
