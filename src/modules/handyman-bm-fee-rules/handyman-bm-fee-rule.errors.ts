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

/* ------------------------------------------------------------------
 * CR-HM-12 PART 06B — bounded TERM + BENEFICIARY errors (FROZEN
 * `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §4.4). Every failure is
 * closed and typed: the fact binds to an exact agreement version or
 * the operation fails — never an implicit default, never a silent
 * rate, never an inferred payee. No code named here mentions a fee
 * value, entitlement, settlement, gateway, or SaaS vocabulary.
 * ------------------------------------------------------------------ */

export function handymanBmFeeTermNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_TERM_NOT_FOUND,
    message: 'Handyman BM fee term definition not found.',
    statusCode: 404,
  });
}

export function handymanBmFeeTermVersionNotDraftError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_TERM_VERSION_NOT_DRAFT,
    message:
      'Handyman BM fee term definitions may only be authored on a DRAFT agreement version.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanBmFeeTermAlreadyDefinedError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_TERM_ALREADY_DEFINED,
    message:
      'This agreement version already defines its single BM fee term.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanBmFeeTermKeyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_TERM_KEY_CONFLICT,
    message:
      'Idempotency key already used for a different Handyman BM fee term payload.',
    statusCode: 409,
  });
}

export function handymanBmFeeTermValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_TERM_VALIDATION,
    message: 'Handyman BM fee term input validation failed.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}

export function handymanBmFeeBeneficiaryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_NOT_FOUND,
    message: 'Handyman BM fee beneficiary definition not found.',
    statusCode: 404,
  });
}

export function handymanBmFeeBeneficiaryVersionNotDraftError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_VERSION_NOT_DRAFT,
    message:
      'Handyman BM fee beneficiary definitions may only be authored on a DRAFT agreement version.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanBmFeeBeneficiaryAlreadyDefinedError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_ALREADY_DEFINED,
    message:
      'This agreement version already defines its single BM fee beneficiary.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanBmFeeBeneficiaryKeyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_KEY_CONFLICT,
    message:
      'Idempotency key already used for a different Handyman BM fee beneficiary payload.',
    statusCode: 409,
  });
}

export function handymanBmFeeBeneficiaryValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_VALIDATION,
    message: 'Handyman BM fee beneficiary input validation failed.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}

/**
 * The beneficiary reference must equal the bound agreement version's
 * own governed client — never a foreign client, channel attribution,
 * vendor, or caller-supplied identity (decision record §3.4/§3.5).
 */
export function handymanBmFeeBeneficiaryClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BM_FEE_BENEFICIARY_CLIENT_MISMATCH,
    message:
      'Handyman BM fee beneficiary reference must equal the bound agreement version client.',
    statusCode: 409,
  });
}
