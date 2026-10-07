import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });

export const utilityBillNotFoundError = (): AppError =>
  error('UTILITY_BILL_NOT_FOUND', 'Utility bill not found.', 404);
export const utilityBillCalculationInvalidError = (): AppError =>
  error('UTILITY_BILL_CALCULATION_INVALID', 'A finalized tenant Electricity or Water calculation is required.', 400);
export const utilityBillContextInvalidError = (): AppError =>
  error('UTILITY_BILL_CONTEXT_INVALID', 'Tenant, Meter, Consumption, Building, or assignment context does not match authoritative BE-18 data.', 400);
export const utilityBillApprovalRequiredError = (): AppError =>
  error('UTILITY_BILL_APPROVAL_REQUIRED', 'The latest Tenant approval must be APPROVED before billing handoff.', 409);
export const utilityBillApprovalRejectedError = (): AppError =>
  error('UTILITY_BILL_APPROVAL_REJECTED', 'The finalized utility charge was rejected and cannot be billed.', 409);
export const utilityBillMeterNotTenantError = (): AppError =>
  error('UTILITY_BILL_METER_NOT_TENANT', 'Only TENANT-purpose meter charges may enter Tenant billing.', 400);
export const utilityBillDuplicateError = (): AppError =>
  error('UTILITY_BILL_ALREADY_EXISTS', 'A Utility bill already exists for this Tenant, Meter, and billing period.', 409);
export const utilityBillUpdateNotAllowedError = (): AppError =>
  error('UTILITY_BILL_UPDATE_NOT_ALLOWED', 'This Utility bill can no longer be updated as requested.', 400);
export const utilityBillStatusTransitionInvalidError = (): AppError =>
  error('UTILITY_BILL_STATUS_TRANSITION_INVALID', 'The requested Utility bill status transition is not allowed.', 400);
