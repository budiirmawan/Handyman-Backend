import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-SAAS-01 PART 05 — SaaS provisioning errors (frozen §13.2 / §17.1).
 *
 * Status-eligibility gate is per frozen §13.2 step 1: the customer's
 * persisted status MUST be one of {PROSPECT, TRIAL, ACTIVE}. Any other
 * status (SUSPENDED, GRACE, PAST_DUE, TERMINATED, INACTIVE, NULL) is
 * refused as `SAAS_PROVISIONING_CUSTOMER_NOT_ELIGIBLE` (409).
 *
 * OCC: the customer aggregate carries a `version` column (PART 01
 * extension) and is in the frozen §17.3 versioned list. The
 * `/customers/:id/provision` body carries `expectedVersion` and
 * mismatches return `409 VERSION_CONFLICT` (the canonical `ver` seam
 * already established by PART 03).
 */

export function saasProvisioningRunNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PROVISIONING_RUN_NOT_FOUND,
    message: 'SaaS provisioning run not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PROVISIONING_RUN', id },
  });
}

export function saasProvisioningCustomerNotEligibleError(
  customerId: string,
  currentStatus: string | null,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PROVISIONING_CUSTOMER_NOT_ELIGIBLE,
    message: `Provisioning refused: customer status '${currentStatus ?? 'NULL'}' is not in {PROSPECT, TRIAL, ACTIVE}.`,
    statusCode: 409,
    resource: { type: 'SAAS_CUSTOMER', id: customerId },
    conflict: {
      reason: 'customer_not_eligible',
      currentStatus,
      eligibleStatuses: ['PROSPECT', 'TRIAL', 'ACTIVE'],
    },
  });
}

export function saasCustomerVersionConflictError(
  customerId: string,
  currentVersion: number,
  expectedVersion: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.VERSION_CONFLICT,
    message:
      'Version conflict: the customer was modified concurrently. Reload and retry.',
    statusCode: 409,
    resource: { type: 'SAAS_CUSTOMER', id: customerId },
    conflict: { version: currentVersion, expectedVersion },
  });
}
