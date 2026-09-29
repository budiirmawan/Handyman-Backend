import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-12 PART 01 — bounded commercial agreement errors. Every
 * failure is closed and typed; nothing resolves implicitly.
 */

export function handymanCommercialAgreementNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_FOUND,
    message: 'Handyman commercial agreement not found.',
    statusCode: 404,
  });
}

export function handymanCommercialAgreementVersionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VERSION_NOT_FOUND,
    message: 'Handyman commercial agreement version not found.',
    statusCode: 404,
  });
}

export function handymanCommercialAgreementIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman commercial agreement version transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanCommercialAgreementActiveExistsError(
  agreementId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_ACTIVE_EXISTS,
    message:
      'A currently ACTIVE Handyman commercial agreement version exists; supersession must land a new version.',
    statusCode: 409,
    details: [`agreementId=${agreementId}`],
  });
}

export function handymanCommercialAgreementClientConflictError(
  clientId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_CLIENT_CONFLICT,
    message:
      'One Handyman commercial agreement per client is the frozen aggregate anchor.',
    statusCode: 409,
    details: [`clientId=${clientId}`],
  });
}

export function handymanCommercialAgreementNotEffectiveAtAsOfError(
  asOf: string,
): AppError {
  return new AppError({
    code:
      ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF,
    message:
      'No Handyman commercial agreement version is effective at the requested as-of instant (fail-closed; no implicit current).',
    statusCode: 409,
    details: [`asOf=${asOf}`],
  });
}

export function handymanCommercialAgreementValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_VALIDATION,
    message: 'Handyman commercial agreement input validation failed.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
