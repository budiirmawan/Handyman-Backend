import { AppError, ERROR_CODES } from '../../shared/errors';

export function configurationAuditEventNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_AUDIT_EVENT_NOT_FOUND,
    message: 'Configuration Audit Event not found.',
    statusCode: 404,
  });
}
