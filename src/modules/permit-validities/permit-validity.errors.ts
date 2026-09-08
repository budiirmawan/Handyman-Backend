import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitValidityNotFoundError = (): AppError =>
  error(ERROR_CODES.PERMIT_VALIDITY_NOT_FOUND, 'Permit Validity not found.', 404);

export const permitValidityContextInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_VALIDITY_CONTEXT_INVALID,
    'Permit validity requires a submitted Application with fully approved context.',
    400,
  );

export const permitValidityBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_VALIDITY_BUILDING_MISMATCH,
    'Validity Building does not match the Permit Building.',
    400,
  );

export const permitValidityInvalidRangeError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_VALIDITY_INVALID_RANGE,
    'validFrom must be before validUntil.',
    400,
  );

export const permitValidityAlreadyOpenError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_VALIDITY_ALREADY_OPEN,
    'Permit already has a PENDING or VALID validity period.',
    409,
  );

export const permitValidityRevokeNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_VALIDITY_REVOKE_NOT_ALLOWED,
    'Only PENDING or VALID Permit validity can be revoked.',
    400,
  );
