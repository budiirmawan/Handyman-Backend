import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-12 PART 04 — bounded BM fee rule errors. Every failure is
 * closed and typed; the rule binds to an exact agreement version or
 * the operation fails — never an implicit default.
 */

export function handymanBmFeeRuleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_FOUND,
    message: 'Handyman BM fee rule definition not found.',
    statusCode: 404,
  });
}

export function handymanBmFeeRuleVersionNotDraftError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_RULE_VERSION_NOT_DRAFT,
    message:
      'Handyman BM fee rule definitions may only be authored on a DRAFT agreement version.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanBmFeeRuleAlreadyDefinedError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_RULE_ALREADY_DEFINED,
    message:
      'This agreement version already defines its single BM fee rule.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanBmFeeRuleKeyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_RULE_KEY_CONFLICT,
    message:
      'Idempotency key already used for a different Handyman BM fee rule payload.',
    statusCode: 409,
  });
}

export function handymanBmFeeRuleNotEffectiveError(
  asOf: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_RULE_NOT_EFFECTIVE,
    message:
      'No Handyman BM fee rule is effective at the requested as-of instant (fail-closed; no implicit current).',
    statusCode: 409,
    details: [`asOf=${asOf}`],
  });
}

export function handymanBmFeeRuleValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_RULE_VALIDATION,
    message: 'Handyman BM fee rule input validation failed.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
