import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18J — Abnormal Consumption error contract. */

export function utilityAbnormalityRuleNotFoundError(
  message = 'Utility abnormality rule not found.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMALITY_RULE_NOT_FOUND,
    message,
    statusCode: 404,
  });
}

/**
 * One rule per (Client, utility type, abnormality type). Two contradictory
 * thresholds for the same check cannot both be right.
 */
export function utilityAbnormalityRuleAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMALITY_RULE_ALREADY_EXISTS,
    message:
      'A rule already exists for this client, utility type and abnormality type.',
    statusCode: 409,
  });
}

/**
 * The threshold cannot drive the requested comparison — missing where one is
 * required, negative, or a percentage that makes no sense.
 */
export function utilityAbnormalityThresholdInvalidError(
  message = 'The detection threshold is not valid for this rule.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMALITY_THRESHOLD_INVALID,
    message,
    statusCode: 400,
  });
}

export function utilityAbnormalConsumptionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMAL_CONSUMPTION_NOT_FOUND,
    message: 'Abnormal consumption record not found.',
    statusCode: 404,
  });
}

/** The referenced consumption is unknown or unusable for detection. */
export function utilityAbnormalConsumptionInvalidError(
  message = 'The referenced consumption is not valid for abnormality detection.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMAL_CONSUMPTION_INVALID,
    message,
    statusCode: 400,
  });
}

/** An identical abnormality is already open for this consumption. */
export function utilityAbnormalConsumptionAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMAL_CONSUMPTION_ALREADY_OPEN,
    message:
      'This abnormality is already open for this consumption.',
    statusCode: 409,
  });
}

/**
 * A closed flag is terminal. Resolving or dismissing it again, or attaching
 * follow-up to it, would rewrite a decision already recorded.
 */
export function utilityAbnormalConsumptionNotOpenError(
  message = 'This abnormal consumption record is already closed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMAL_CONSUMPTION_NOT_OPEN,
    message,
    statusCode: 409,
  });
}

/** A Finding is already linked, or the one supplied does not belong here. */
export function utilityAbnormalConsumptionFindingConflictError(
  message = 'A finding is already linked to this abnormal consumption record.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_ABNORMAL_CONSUMPTION_FINDING_CONFLICT,
    message,
    statusCode: 409,
  });
}
