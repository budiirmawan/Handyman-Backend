import { AppError, ERROR_CODES } from '../../shared/errors';

export function findingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_NOT_FOUND,
    message: 'Finding not found.',
    statusCode: 404,
  });
}

export function findingNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_NUMBER_ALREADY_EXISTS,
    message: 'A finding with this number already exists for this client.',
    statusCode: 409,
  });
}

export function findingBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_BUILDING_CLIENT_MISMATCH,
    message: 'The building does not belong to the specified client.',
    statusCode: 400,
  });
}

export function findingNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_NOT_OPEN,
    message: 'Only open findings can be modified.',
    statusCode: 400,
  });
}

export function findingSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_SOURCE_NOT_FOUND,
    message: 'Finding source not found.',
    statusCode: 404,
  });
}

export function findingSourceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_SOURCE_CLIENT_MISMATCH,
    message: 'Finding source belongs to another client.',
    statusCode: 400,
  });
}

export function findingSourceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_SOURCE_BUILDING_MISMATCH,
    message: 'Finding source belongs to another building.',
    statusCode: 400,
  });
}

export function findingInvalidTransitionError(from: string, to: string): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_INVALID_TRANSITION,
    message: `Finding cannot transition from ${from} to ${to}.`,
    statusCode: 400,
  });
}

export function findingStateAssignmentRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_STATE_ASSIGNMENT_REQUIRED,
    message: 'An active responsible-party assignment is required for this state.',
    statusCode: 400,
  });
}
