import { AppError, ERROR_CODES } from '../../shared/errors';

export function housekeepingReportInvalidDateRangeError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOUSEKEEPING_REPORT_INVALID_DATE_RANGE,
    message: 'dateFrom must not be after dateTo.',
    statusCode: 400,
  });
}
