import { AppError, ERROR_CODES } from '../../shared/errors';

export function cleaningAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_ASSIGNMENT_NOT_FOUND,
    message: 'Cleaning assignment not found.',
    statusCode: 404,
  });
}

export function cleaningAssignmentTaskTerminalError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_ASSIGNMENT_TASK_TERMINAL,
    message: 'Terminal cleaning task cannot be assigned or reassigned.',
    statusCode: 400,
  });
}

export function cleaningAssignmentClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_ASSIGNMENT_CLIENT_MISMATCH,
    message: 'The assignee belongs to a different client.',
    statusCode: 400,
  });
}

export function cleaningAssignmentBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_ASSIGNMENT_BUILDING_MISMATCH,
    message: 'The assignee cannot operate in this building context.',
    statusCode: 400,
  });
}

export function cleaningAssignmentAssigneeInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_ASSIGNMENT_ASSIGNEE_INACTIVE,
    message: 'Inactive workforce profile or team cannot receive assignments.',
    statusCode: 400,
  });
}
