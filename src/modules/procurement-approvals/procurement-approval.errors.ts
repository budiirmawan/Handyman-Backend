import { AppError, ERROR_CODES } from '../../shared/errors';

function make(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError {
  return new AppError({ code, message, statusCode });
}

export function procurementApprovalNotFoundError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_NOT_FOUND,
    'Procurement approval binding not found.',
    404,
  );
}

export function procurementApprovalRequestInvalidError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_REQUEST_INVALID,
    'The referenced Procurement request is invalid or not open.',
    400,
  );
}

export function procurementApprovalApproverInvalidError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_APPROVER_INVALID,
    'The approver must be an active User with access to the request Building.',
    400,
  );
}

export function procurementApprovalAlreadyPendingError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_ALREADY_PENDING,
    'A matching pending approval already exists.',
    409,
  );
}

export function procurementApprovalAlreadyDecidedError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_ALREADY_DECIDED,
    'The approval decision is final and cannot be overwritten.',
    409,
  );
}

export function procurementApprovalUnauthorizedApproverError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_UNAUTHORIZED_APPROVER,
    'Only the assigned authorized approver may decide this approval.',
    403,
  );
}

export function procurementApprovalActionNotAllowedError(
  action: string,
): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_ACTION_NOT_ALLOWED,
    `Approval action ${action} is not allowed.`,
    403,
  );
}

export function procurementApprovalApprovedQuantityNotApplicableError(): AppError {
  return make(
    ERROR_CODES.PROCUREMENT_APPROVAL_APPROVED_QUANTITY_NOT_APPLICABLE,
    'approvedQuantity is only applicable when approving a MATERIAL_REQUEST approval binding.',
    400,
  );
}

export function materialRequestApprovedQuantityInvalidError(): AppError {
  return make(
    ERROR_CODES.MATERIAL_REQUEST_APPROVED_QUANTITY_INVALID,
    'Approved quantity must be a positive number.',
    400,
  );
}

export function materialRequestApprovedQuantityExceedsRequestedError(): AppError {
  return make(
    ERROR_CODES.MATERIAL_REQUEST_APPROVED_QUANTITY_EXCEEDS_REQUESTED,
    'Approved quantity must not exceed the requested Material Request quantity.',
    400,
  );
}
