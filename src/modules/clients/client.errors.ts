import { AppError, ERROR_CODES } from '../../shared/errors';

export function clientNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_NOT_FOUND,
    message: 'Client not found.',
    statusCode: 404,
  });
}

export function clientCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_CODE_ALREADY_EXISTS,
    message: 'A client with this code already exists.',
    statusCode: 409,
  });
}

export function clientInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_INACTIVE,
    message: 'Inactive clients cannot be used as operational context.',
    statusCode: 400,
  });
}

/**
 * CR-HM-BE-CLIENT-MASTER-01 — the Client exists but is outside the caller's
 * authorized Client reach.
 *
 * It is raised only for an existing, out-of-scope Client — the same
 * distinction `BUILDING_ACCESS_DENIED` already makes for Buildings. An unknown
 * Client id keeps the existing `404 CLIENT_NOT_FOUND` contract. The denial is
 * never an existence decision a caller can act on: Client ids are
 * server-generated UUIDs and the caller must already hold `client.read` /
 * `client.manage`. The Owner (PLATFORM_ADMIN) is never denied; every other
 * caller is limited to Clients reachable through ACTIVE Building assignments.
 */
export function clientAccessDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_ACCESS_DENIED,
    message: 'Client access denied.',
    statusCode: 403,
  });
}
