import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });
export const serviceChargeReadinessNotFoundError = (): AppError =>
  error('SERVICE_CHARGE_READINESS_NOT_FOUND', 'Service Charge Readiness not found.', 404);
export const serviceChargeReadinessContextInvalidError = (): AppError =>
  error('SERVICE_CHARGE_READINESS_CONTEXT_INVALID', 'An active Tenant and Building context is required.', 400);
export const serviceChargeReadinessSpaceMismatchError = (): AppError =>
  error('SERVICE_CHARGE_READINESS_SPACE_MISMATCH', 'The Space must have an active relationship to the Tenant in this Building.', 400);
export const serviceChargeReadinessChargeInvalidError = (): AppError =>
  error('SERVICE_CHARGE_READINESS_CHARGE_INVALID', 'The referenced BE-19A Tenant Charge does not match the readiness context, type, period, or active state.', 400);
export const serviceChargeReadinessStatusMismatchError = (): AppError =>
  error('SERVICE_CHARGE_READINESS_STATUS_MISMATCH', 'The requested readiness status does not match the resolved readiness.', 400);
export const serviceChargeReadinessAlreadyExistsError = (): AppError =>
  error('SERVICE_CHARGE_READINESS_ALREADY_EXISTS', 'Readiness already exists for this Tenant, Space, type, and period.', 409);
