import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment errors.
 *
 * Reuses the single AppError authority. Overspend is always an explicit,
 * inspectable rejection carrying the amounts that produced it — it is never
 * silently permitted and never silently truncated.
 */

const error = (
  code: keyof typeof ERROR_CODES,
  message: string,
  statusCode: number,
): AppError => new AppError({ code: ERROR_CODES[code], message, statusCode });

export const operationalCommitmentNotFoundError = (): AppError =>
  error('OPERATIONAL_COMMITMENT_NOT_FOUND', 'Operational Commitment not found.', 404);

export const operationalBudgetNotActiveError = (status: string): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_BUDGET_NOT_ACTIVE,
    message: 'Only an ACTIVE Operational Budget can carry commitments.',
    statusCode: 409,
    details: [{ field: 'status', message: `current budget status is ${status}` }],
  });

export const operationalCommitmentCurrencyMismatchError = (): AppError =>
  error(
    'OPERATIONAL_COMMITMENT_CURRENCY_MISMATCH',
    'A commitment must use its Operational Budget currency.',
    400,
  );

export const operationalCommitmentCategoryMismatchError = (): AppError =>
  error(
    'OPERATIONAL_COMMITMENT_CATEGORY_MISMATCH',
    'The budget category does not belong to this Operational Budget.',
    400,
  );

export const operationalCommitmentNotOpenError = (status: string): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_COMMITMENT_NOT_OPEN,
    message: 'This Operational Commitment is closed and can no longer change.',
    statusCode: 409,
    details: [{ field: 'status', message: `current status is ${status}` }],
  });

export const operationalCommitmentDecreaseBelowActualizedError = (): AppError =>
  error(
    'OPERATIONAL_COMMITMENT_DECREASE_BELOW_ACTUALIZED',
    'A commitment cannot be decreased below the amount already actualized.',
    409,
  );

export const operationalCommitmentCancelAfterActualizationError = (): AppError =>
  error(
    'OPERATIONAL_COMMITMENT_CANCEL_AFTER_ACTUALIZATION',
    'A partially actualized commitment must be released, not cancelled.',
    409,
  );

export const operationalCommitmentActualizationExceedsOpenError = (): AppError =>
  error(
    'OPERATIONAL_COMMITMENT_ACTUALIZATION_EXCEEDS_OPEN',
    'Actualization cannot exceed the open amount of the commitment.',
    409,
  );

export const operationalBudgetOverspendRejectedError = (context: {
  requestedAmount: string;
  availableAmount: string;
  plannedAmount: string;
  consumedAmount: string;
  scope: 'CATEGORY' | 'BUDGET';
}): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_BUDGET_OVERSPEND_REJECTED,
    message:
      'The requested commitment exceeds the available Operational Budget.',
    statusCode: 409,
    details: [
      { field: 'scope', message: context.scope },
      { field: 'plannedAmount', message: context.plannedAmount },
      { field: 'consumedAmount', message: context.consumedAmount },
      { field: 'availableAmount', message: context.availableAmount },
      { field: 'requestedAmount', message: context.requestedAmount },
    ],
  });

export const operationalBudgetOverspendOverrideNotAllowedError = (): AppError =>
  error(
    'OPERATIONAL_BUDGET_OVERSPEND_OVERRIDE_NOT_ALLOWED',
    'This Operational Budget does not allow an overspend override.',
    409,
  );

export const operationalCommitmentSourceNotEligibleError = (
  detail: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_COMMITMENT_SOURCE_NOT_ELIGIBLE,
    message: 'This source transaction cannot create an Operational Commitment.',
    statusCode: 409,
    details: [{ field: 'source', message: detail }],
  });

export const operationalCommitmentSourceAlreadyCommittedError = (
  detail: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_COMMITMENT_SOURCE_ALREADY_COMMITTED,
    message: 'This source transaction already has an Operational Commitment.',
    statusCode: 409,
    details: [{ field: 'source', message: detail }],
  });

export const operationalBudgetPolicyTransitionInvalidError = (
  status: string,
): AppError =>
  new AppError({
    code: ERROR_CODES.OPERATIONAL_BUDGET_POLICY_TRANSITION_INVALID,
    message:
      'The overspend policy can only be changed while the Operational Budget is DRAFT or ACTIVE.',
    statusCode: 409,
    details: [{ field: 'status', message: `current status is ${status}` }],
  });
