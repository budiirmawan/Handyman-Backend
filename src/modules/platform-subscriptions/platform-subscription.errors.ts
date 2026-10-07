import { AppError, ERROR_CODES } from '../../shared/errors';

/** 404 — the subscription row does not exist. */
export function saasSubscriptionNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_SUBSCRIPTION_NOT_FOUND,
    message: 'SaaS subscription not found.',
    statusCode: 404,
    resource: { type: 'SAAS_SUBSCRIPTION', id },
  });
}

/**
 * 409 (frozen §11.2) — the requested lifecycle transition is not in the
 * frozen table for the subscription's current state. The current state is
 * carried in `conflict` so callers can reload and recover.
 */
export function saasSubscriptionTransitionNotAllowedError(
  from: string,
  to: string,
  allowedFrom: readonly string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED,
    message: `Subscription transition ${from} → ${to} is not allowed.`,
    statusCode: 409,
    conflict: { from, to, allowedFrom },
  });
}

/**
 * 400 (frozen §17.1) — trial metadata violates the frozen date rules
 * (trial end must be a future timestamp at creation/activation).
 */
export function saasSubscriptionTrialInvalidError(message: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_SUBSCRIPTION_TRIAL_INVALID,
    message,
    statusCode: 400,
    details: [{ field: 'trialEndDate', message }],
  });
}

/**
 * 409 (frozen §17.3) — optimistic-concurrency rejection: the aggregate
 * changed after the caller read it. Carries the server state for a safe
 * reload (`conflict: { version, expectedVersion }` — the canonical
 * conflict payload established by PART 01).
 */
export function saasSubscriptionVersionConflictError(
  id: string,
  currentVersion: number,
  expectedVersion: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.VERSION_CONFLICT,
    message:
      'Version conflict: the subscription was modified concurrently. Reload and retry.',
    statusCode: 409,
    resource: { type: 'SAAS_SUBSCRIPTION', id },
    conflict: { version: currentVersion, expectedVersion },
  });
}

/**
 * 409 (frozen §7.2) — the customer's lifecycle state forbids the
 * subscription command (terminal customers cannot gain new commercial
 * state; legacy `INACTIVE` maps to TERMINATED in projections).
 */
export function saasSubscriptionCustomerStatusError(
  customerId: string,
  customerStatus: string,
  command: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_CUSTOMER_STATUS_NOT_ALLOWED,
    message: `The customer is in state ${customerStatus}; ${command} is not allowed for this customer.`,
    statusCode: 409,
    resource: { type: 'SAAS_CUSTOMER', id: customerId },
    conflict: { customerStatus, command },
  });
}

/**
 * 409 (frozen §11.5) — reactivation prerequisites unmet. Either there
 * is still an outstanding invoice, or the caller has not authorised the
 * override. The structured `conflict` lets clients distinguish
 * `unpaid` vs `override_required` vs `invalid_state`.
 */
export function saasSubscriptionReactivationDeniedError(
  subscriptionId: string,
  reason: 'unpaid' | 'override_required' | 'invalid_state',
  details: {
    outstandingInvoiceIds?: readonly string[];
    expectedOverrideReason?: boolean;
    fromStatus?: string;
  } = {},
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_SUBSCRIPTION_REACTIVATION_DENIED,
    message:
      reason === 'unpaid'
        ? 'Subscription cannot be reactivated while an outstanding invoice exists.'
        : reason === 'override_required'
          ? 'Subscription reactivation requires an overrideReason.'
          : 'Subscription is not in a reactivation-eligible state.',
    statusCode: 409,
    resource: { type: 'SAAS_SUBSCRIPTION', id: subscriptionId },
    conflict: { reason, ...details },
  });
}

/**
 * 403 (frozen §12.2.3 + §17.1) — business-plane access while the
 * customer's effective subscription is SUSPENDED. The active policy
 * value rides in `details.suspendedAccessPolicy` so consumers know
 * whether the surface is READ_ONLY / LIMITED_ACCESS / FULL_BLOCK.
 */
export function saasSubscriptionSuspendedError(
  customerId: string,
  subscriptionId: string,
  policy: 'READ_ONLY' | 'LIMITED_ACCESS' | 'FULL_BLOCK',
  attemptedOperation: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_SUBSCRIPTION_SUSPENDED,
    message:
      'Subscription is SUSPENDED; the business-plane operation is denied by the active suspension policy.',
    statusCode: 403,
    resource: { type: 'SAAS_CUSTOMER', id: customerId },
    details: [
      {
        field: 'suspendedAccessPolicy',
        message: `policy=${policy}`,
      },
      {
        field: 'suspendedSubscriptionId',
        message: subscriptionId,
      },
      {
        field: 'attemptedOperation',
        message: attemptedOperation,
      },
    ],
  });
}
