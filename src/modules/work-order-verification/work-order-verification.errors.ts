import { AppError, ERROR_CODES } from '../../shared/errors';
import type { BastClosureBlocker } from '../bast-documents';

/** The Work Order is not COMPLETED, so it cannot be verified. */
export function workOrderVerificationInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_VERIFICATION_INVALID_STATE,
    message: 'Only completed work orders can be verified.',
    statusCode: 400,
  });
}

/** The Work Order is already APPROVED and awaiting closure. */
export function workOrderVerificationAlreadyApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_VERIFICATION_ALREADY_APPROVED,
    message: 'This work order is already approved and cannot be re-verified.',
    statusCode: 409,
  });
}

/** The Work Order is not COMPLETED, so it cannot be closed. */
export function workOrderCloseInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_CLOSE_INVALID_STATE,
    message: 'Only completed work orders can be closed.',
    statusCode: 400,
  });
}

/** The Work Order is COMPLETED but has not been APPROVED. */
export function workOrderCloseNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_CLOSE_NOT_APPROVED,
    message: 'A work order must be approved before it can be closed.',
    statusCode: 400,
  });
}

/** Canonical BE-22 acceptance does not satisfy the configured cardinality. */
export function workOrderCloseBastNotReadyError(
  blockers: BastClosureBlocker[],
): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_CLOSE_BAST_NOT_READY,
    message: 'Canonical BAST requirements must be satisfied before closure.',
    statusCode: 409,
    details: blockers.map((blocker) => ({
      field: 'bastRequirement',
      message: blocker.code,
      ...(blocker.vendorWorkId
        ? { vendorWorkId: blocker.vendorWorkId }
        : {}),
    })),
  });
}

/** The Work Order is already CLOSED. */
export function workOrderCloseAlreadyClosedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_CLOSE_ALREADY_CLOSED,
    message: 'This work order is already closed.',
    statusCode: 409,
  });
}
