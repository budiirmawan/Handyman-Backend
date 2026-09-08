import { AppError, ERROR_CODES } from '../../shared/errors';
export function findingAssignmentNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_ASSIGNMENT_NOT_FOUND, message: 'Finding assignment not found.', statusCode: 404 });
}
export function findingAssignmentClientMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_ASSIGNMENT_CLIENT_MISMATCH, message: 'The assignee does not belong to the finding client.', statusCode: 400 });
}
export function findingAssignmentBuildingMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_ASSIGNMENT_BUILDING_MISMATCH, message: 'The assignee is not available for the finding building.', statusCode: 400 });
}
export function findingAssignmentVendorWorkforceMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_ASSIGNMENT_VENDOR_WORKFORCE_MISMATCH, message: 'The workforce profile is not actively bound to the selected vendor.', statusCode: 400 });
}
export function findingAssignmentAlreadyAssignedError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_ASSIGNMENT_ALREADY_ASSIGNED, message: 'This finding already has an active assignment.', statusCode: 409 });
}
