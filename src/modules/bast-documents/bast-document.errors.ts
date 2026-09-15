import { AppError, ERROR_CODES } from '../../shared/errors';

export function bastDocumentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.BAST_NOT_FOUND, message: 'BAST document not found.', statusCode: 404 });
}
export function bastWorkNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.WORK_COMPLETION_WORK_NOT_FOUND, message: 'Work not found for BAST.', statusCode: 404 });
}
export function bastWorkNotCompletedError(): AppError {
  return new AppError({ code: ERROR_CODES.WORK_COMPLETION_WORK_NOT_COMPLETED, message: 'Work is not completed and cannot have a BAST.', statusCode: 400 });
}
export function bastContextMismatchError(message?: string): AppError {
  return new AppError({ code: ERROR_CODES.WORK_COMPLETION_CONTEXT_MISMATCH, message: message ?? 'BAST context is invalid.', statusCode: 400 });
}
export function bastBuildingMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.BAST_BUILDING_MISMATCH, message: 'BAST building does not match work context.', statusCode: 400 });
}
export function bastNumberAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.BAST_NUMBER_ALREADY_EXISTS, message: 'BAST number already exists for this client.', statusCode: 409 });
}
export function bastAlreadyExistsError(): AppError {
  return new AppError({ code: ERROR_CODES.BAST_ALREADY_EXISTS, message: 'BAST already exists for this work.', statusCode: 409 });
}
export function bastInvalidTransitionError(
  currentStatus: string,
  command: 'submit' | 'resubmit' | 'decide',
): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_INVALID_TRANSITION,
    message: `Cannot ${command} BAST from ${currentStatus}.`,
    statusCode: 409,
  });
}
export function bastNotReadyError(message: string): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_NOT_READY,
    message,
    statusCode: 409,
  });
}
export function bastReconciliationRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAST_RECONCILIATION_REQUIRED,
    message: 'BAST reconciliation quarantine must be resolved before submission.',
    statusCode: 409,
  });
}
