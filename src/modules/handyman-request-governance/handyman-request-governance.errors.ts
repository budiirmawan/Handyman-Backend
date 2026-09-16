import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-03 RUN 1 — Handyman Request governance errors.
 *
 * Reuses the existing foundation errors wherever the violated rule belongs
 * to another authority (HANDYMAN_REQUEST_NOT_FOUND /
 * HANDYMAN_REQUEST_STATUS_INVALID from CR-HM-BE-01, SERVICE_CATALOG_NOT_FOUND
 * / SERVICE_CATALOG_NOT_ACTIVE from CR-BE-SVC-01, BUILDING_ACCESS_DENIED from
 * BE-02G). Only Handyman-governance rules get dedicated codes here.
 */

export function handymanTriageNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_TRIAGE_NOT_FOUND,
    message: 'Handyman request triage decision not found.',
    statusCode: 404,
  });
}

export function handymanRequestTriageNotAllowedError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_TRIAGE_NOT_ALLOWED,
    message:
      message ??
      'The handyman request is not in a lifecycle state that allows this triage decision.',
    statusCode: 409,
  });
}

export function handymanRequestServiceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_SERVICE_NOT_FOUND,
    message: 'Handyman request service selection not found.',
    statusCode: 404,
  });
}

export function handymanRequestServiceAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_SERVICE_ALREADY_ACTIVE,
    message:
      'This service already holds an active selection for this handyman request.',
    statusCode: 409,
  });
}

export function handymanRequestServiceSourceInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_SERVICE_SOURCE_INVALID,
    message:
      message ??
      'The selection source does not match the governed triage/inspection lifecycle of this request.',
    statusCode: 409,
  });
}

export function handymanRequestServiceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_SERVICE_CLIENT_MISMATCH,
    message:
      'The service catalog entry does not belong to the client of this handyman request.',
    statusCode: 400,
  });
}

export function handymanRequestServiceNotHandymanError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_SERVICE_NOT_HANDYMAN,
    message:
      'The service catalog entry is not in the governed HANDYMAN category.',
    statusCode: 400,
  });
}

export function handymanRequestServiceStateInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_SERVICE_STATE_INVALID,
    message:
      message ??
      'The service selection is not in the expected state for this operation.',
    statusCode: 409,
  });
}

export function handymanInspectionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_NOT_FOUND,
    message: 'Handyman inspection not found.',
    statusCode: 404,
  });
}

export function handymanInspectionAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_ALREADY_OPEN,
    message: 'This handyman request already has an open inspection.',
    statusCode: 409,
  });
}

export function handymanInspectionNotAllowedError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_NOT_ALLOWED,
    message:
      message ??
      'An inspection may only be opened for a request whose active triage path requires inspection.',
    statusCode: 409,
  });
}

export function handymanInspectionStateInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_STATE_INVALID,
    message:
      message ??
      'The inspection is not in the expected state for this operation.',
    statusCode: 409,
  });
}

export function handymanInspectionChecklistInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_CHECKLIST_INVALID,
    message:
      message ??
      'The bound checklist execution is not valid for this handyman inspection.',
    statusCode: 400,
  });
}
