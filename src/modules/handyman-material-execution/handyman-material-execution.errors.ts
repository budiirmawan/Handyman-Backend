import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-09 PART 01 — persistence-boundary errors ONLY. No command,
 * lifecycle, approval, or financial errors exist at this boundary
 * (no commands exist in this PART).
 */
export function handymanMaterialExecutionLineNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_EXECUTION_LINE_NOT_FOUND,
    message: 'Handyman material execution line not found.',
    statusCode: 404,
  });
}
