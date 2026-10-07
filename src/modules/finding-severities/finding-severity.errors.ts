import { AppError, ERROR_CODES } from '../../shared/errors';
export function findingSeverityNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_SEVERITY_NOT_FOUND, message: 'Finding severity not found.', statusCode: 404 });
}
export function findingSeverityCodeAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_SEVERITY_CODE_ALREADY_EXISTS, message: 'A finding severity with this code already exists for this client.', statusCode: 409 });
}
export function findingSeverityInactiveError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_SEVERITY_INACTIVE, message: 'Inactive finding severity cannot be assigned.', statusCode: 400 });
}
export function findingSeverityClientMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_SEVERITY_CLIENT_MISMATCH, message: 'Finding severity belongs to another client.', statusCode: 400 });
}
