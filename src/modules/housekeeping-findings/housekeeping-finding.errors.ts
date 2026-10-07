import { AppError, ERROR_CODES } from '../../shared/errors';

export function housekeepingFindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_FINDING_NOT_FOUND,
    message: 'Housekeeping finding context not found.',
    statusCode: 404,
  });
}

export function housekeepingFindingAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_FINDING_ALREADY_LINKED,
    message: 'Finding is already linked to a Housekeeping context.',
    statusCode: 409,
  });
}

export function housekeepingFindingSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_FINDING_SOURCE_NOT_FOUND,
    message: 'Housekeeping operational source does not exist.',
    statusCode: 404,
  });
}

export function housekeepingFindingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_FINDING_CLIENT_MISMATCH,
    message: 'Housekeeping source belongs to a different client.',
    statusCode: 400,
  });
}

export function housekeepingFindingBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_FINDING_BUILDING_MISMATCH,
    message: 'Housekeeping source belongs to a different building.',
    statusCode: 400,
  });
}
