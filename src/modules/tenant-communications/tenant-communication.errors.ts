import { AppError, ERROR_CODES } from '../../shared/errors';

const make = (code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number) =>
  new AppError({ code, message, statusCode });

export const tenantCommunicationNotFoundError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_NOT_FOUND, 'Tenant communication not found.', 404);
export const tenantCommunicationRecipientInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_RECIPIENT_INVALID, 'The recipient must belong to the Tenant and requested context.', 400);
export const tenantCommunicationRelatedInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_RELATED_INVALID, 'The related Tenant record is invalid or belongs to another context.', 400);
export const tenantCommunicationContextInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_CONTEXT_INVALID, 'The Building is not an active context of the Tenant.', 400);
export const tenantCommunicationNotDraftError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_NOT_DRAFT, 'Only a draft communication can be updated or sent.', 400);
export const tenantCommunicationAlreadyReadError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_ALREADY_READ, 'The communication has already been read.', 409);
export const tenantCommunicationNotSentError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_NOT_SENT, 'Only a sent communication can be marked read.', 400);
export const tenantCommunicationUnauthorizedError = (): AppError =>
  make(ERROR_CODES.TENANT_COMMUNICATION_UNAUTHORIZED, 'The acting User is not authorized for this communication action.', 403);
