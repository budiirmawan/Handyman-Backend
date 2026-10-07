import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const safetyFieldReportNotFoundError = (): AppError =>
  error(
    ERROR_CODES.SAFETY_FIELD_REPORT_NOT_FOUND,
    'Safety field report not found.',
    404,
  );

export const safetyReportActiveShiftRequiredError = (): AppError =>
  error(
    ERROR_CODES.SAFETY_REPORT_ACTIVE_SHIFT_REQUIRED,
    'Safety field reporting requires an active current shift in the requested building.',
    409,
  );

export const safetyReportShiftAmbiguousError = (): AppError =>
  error(
    ERROR_CODES.SAFETY_REPORT_SHIFT_AMBIGUOUS,
    'Multiple active current shift assignments match the reporting context; cannot determine reporting shift.',
    409,
  );

export const safetyReportBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.SAFETY_REPORT_BUILDING_MISMATCH,
    'The requested building does not match the reporting field context building.',
    409,
  );
