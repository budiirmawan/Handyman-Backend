import { AppError, ERROR_CODES } from '../../shared/errors';

export function userBuildingAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.USER_BUILDING_ASSIGNMENT_NOT_FOUND,
    message: 'Active user building assignment not found.',
    statusCode: 404,
  });
}

export function userBuildingAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.USER_BUILDING_ALREADY_ASSIGNED,
    message: 'This user is already assigned to this building.',
    statusCode: 409,
  });
}

export function buildingNotAvailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot be assigned to users.',
    statusCode: 400,
  });
}
