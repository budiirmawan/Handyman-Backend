import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitApprovalNotFoundError = (): AppError =>
  error(ERROR_CODES.PERMIT_APPROVAL_NOT_FOUND, 'Permit Approval not found.', 404);

export const permitApprovalContextInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_CONTEXT_INVALID,
    'Permit Application must exist and be SUBMITTED before approval.',
    400,
  );

export const permitApprovalApproverInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_APPROVER_INVALID,
    'Approver must be active, Building-authorized, and hold permit.approve.',
    400,
  );

export const permitApprovalAlreadyExistsError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_ALREADY_EXISTS,
    'This approval stage/type is already bound to the Permit Application.',
    409,
  );

export const permitApprovalAlreadyDecidedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_ALREADY_DECIDED,
    'The final approval decision cannot be overwritten.',
    409,
  );

export const permitApprovalUnauthorizedApproverError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_UNAUTHORIZED_APPROVER,
    'Only the assigned authorized approver may decide this approval.',
    403,
  );

export const permitApprovalActionNotAllowedError = (action: string): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_ACTION_NOT_ALLOWED,
    `Permit approval action ${action} is not allowed.`,
    403,
  );

export const permitApprovalSafetyNotReadyError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPROVAL_SAFETY_NOT_READY,
    'Required Permit Safety Requirements must be READY before approval.',
    400,
  );
