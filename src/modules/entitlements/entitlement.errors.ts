import { AppError, ERROR_CODES } from '../../shared/errors';

export function entitlementNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENTITLEMENT_NOT_FOUND,
    message: 'Module entitlement not found.',
    statusCode: 404,
  });
}

export function entitlementAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENTITLEMENT_ALREADY_EXISTS,
    message: 'This subscription already has an ACTIVE entitlement for this module.',
    statusCode: 409,
  });
}

export function entitlementCommercialContextInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENTITLEMENT_COMMERCIAL_CONTEXT_INVALID,
    message: 'Cannot activate entitlement: the commercial context is invalid.',
    statusCode: 400,
  });
}

// ---------------------------------------------------------------------------
// CR-BE-SAAS-01 PART 04 — SaaS entitlement & quota errors (frozen §17.1)
// ---------------------------------------------------------------------------

/**
 * The customer's subscription does not entitle the capability (frozen
 * §17.1/§12.2). A COMMERCIAL denial — never an RBAC 403: the actor
 * authorization question is answered separately by the business plane, and
 * both gates must pass.
 */
export function saasEntitlementNotFoundError(capabilityCode?: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_ENTITLEMENT_NOT_FOUND,
    message: capabilityCode
      ? `Capability ${capabilityCode} is not entitled for this customer's subscription.`
      : 'SaaS entitlement not found.',
    statusCode: 404,
  });
}

/**
 * Frozen §17.1: 409 carrying `{limitKey, limit, used}`.
 */
export function saasQuotaExceededError(
  limitKey: string,
  limit: number,
  used: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_QUOTA_EXCEEDED,
    message: `Quota exceeded for ${limitKey}: used ${used} of ${limit}.`,
    statusCode: 409,
    conflict: { limitKey, limit, used },
  });
}
