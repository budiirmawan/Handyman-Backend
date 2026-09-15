import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-02 RUN 1 — Handyman Provider designation errors.
 *
 * Reuses the existing foundation errors wherever the violated rule belongs
 * to another authority (CLIENT_NOT_FOUND / CLIENT_INACTIVE from BE-02A,
 * VENDOR_NOT_FOUND / VENDOR_INACTIVE from BE-06A, MODULE_NOT_FOUND /
 * MODULE_INACTIVE from BE-02C, BUILDING_ACCESS_DENIED from BE-02G). Only
 * Handyman-context rules get dedicated codes here.
 */

export function handymanProviderNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_NOT_FOUND,
    message: 'Handyman provider designation not found.',
    statusCode: 404,
  });
}

export function handymanProviderAlreadyDesignatedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_ALREADY_DESIGNATED,
    message:
      'This vendor already holds an active handyman provider designation for this client.',
    statusCode: 409,
  });
}

export function handymanProviderStatusInvalidError(message?: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_STATUS_INVALID,
    message:
      message ??
      'The handyman provider designation is not in the expected status for this transition.',
    statusCode: 400,
  });
}

export function handymanProviderVendorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_VENDOR_CLIENT_MISMATCH,
    message: 'The vendor does not belong to the specified client.',
    statusCode: 400,
  });
}

export function handymanProviderModuleNotEntitledError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_MODULE_NOT_ENTITLED,
    message:
      'The client does not hold an effective HANDYMAN module entitlement.',
    statusCode: 403,
  });
}
