import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-07 PART 04A — persistence-boundary error for the terminal
 * arrival result store. Exactly one surface: the one-result-per-
 * challenge conflict (governance §15). No decision/verdict errors
 * exist at this boundary — evaluation errors do not exist because no
 * evaluator exists in this PART.
 */
export function arrivalResultConflictError(challengeId: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_ARRIVAL_RESULT_CONFLICT,
    message:
      'A terminal arrival verification result already exists for this challenge.',
    statusCode: 409,
    details: [`challengeId=${challengeId}`],
  });
}
