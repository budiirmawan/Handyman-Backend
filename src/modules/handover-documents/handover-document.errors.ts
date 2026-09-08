import { AppError, ERROR_CODES } from '../../shared/errors';

export function handoverDocumentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_DOCUMENT_NOT_FOUND, message: 'Handover document not found.', statusCode: 404 });
}
export function handoverWorkNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_WORK_NOT_FOUND, message: 'Work not found for handover.', statusCode: 404 });
}
export function handoverWorkNotCompletedError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_WORK_NOT_COMPLETED, message: 'Work is not completed and cannot have a handover.', statusCode: 400 });
}
export function handoverContextMismatchError(message?: string): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_CONTEXT_MISMATCH, message: message ?? 'Handover context is invalid.', statusCode: 400 });
}
export function handoverBuildingMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_BUILDING_MISMATCH, message: 'Handover building does not match work context.', statusCode: 400 });
}
export function handoverBastNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_BAST_NOT_FOUND, message: 'BAST not found for handover.', statusCode: 404 });
}
export function handoverBastMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_BAST_MISMATCH, message: 'BAST does not match work context.', statusCode: 400 });
}
export function handoverNumberAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_NUMBER_ALREADY_EXISTS, message: 'Handover number already exists for this client.', statusCode: 409 });
}
export function handoverAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.HANDOVER_ALREADY_EXISTS, message: 'Handover already exists for this work.', statusCode: 409 });
}
