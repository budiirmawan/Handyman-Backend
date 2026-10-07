import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26I — Notification escalation errors.
 */
export function notificationEscalationNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_ESCALATION_NOT_FOUND,
    message: 'Notification escalation not found.',
    statusCode: 404,
    resource: { type: 'NOTIFICATION_ESCALATION', id },
  });
}

export function notificationEscalationKeyAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_ESCALATION_KEY_ALREADY_EXISTS,
    message: 'A notification escalation with this key already exists.',
    statusCode: 409,
  });
}

/** The referenced BE-26B template does not exist (create/update validation). */
export function notificationEscalationTemplateMissingError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_ESCALATION_TEMPLATE_NOT_FOUND,
    message: 'Referenced notification template not found.',
    statusCode: 400,
    details: [
      {
        field: 'templateKey',
        message: 'Referenced notification template does not exist.',
      },
    ],
  });
}

/** The escalation is not PENDING, so the transition is not allowed. */
export function notificationEscalationNotPendingError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_ESCALATION_NOT_PENDING,
    message: 'The escalation is not PENDING.',
    statusCode: 409,
  });
}
