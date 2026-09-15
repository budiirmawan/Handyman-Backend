import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * Raised when the stored structure chain contradicts itself (e.g. a Campus
 * pointing at a different Property than its Building). FKs make this nearly
 * impossible, so it signals a data-integrity fault — not a caller error.
 */
export function hierarchyInconsistentError(detail: string): AppError {
  return new AppError({
    code: ERROR_CODES.HIERARCHY_INCONSISTENT,
    message: `Building structure hierarchy is inconsistent: ${detail}`,
    statusCode: 500,
  });
}
