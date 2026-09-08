export {
  AVAILABLE_EMAIL_PROVIDERS,
  CREDENTIAL_LESS_EMAIL_PROVIDERS,
  CaptureEmailAdapter,
  NoopEmailAdapter,
  resolveEmailAdapter,
} from './email-adapter';
export type {
  CaptureEmailAdapterOutcome,
  CapturedEmailSend,
  EmailAdapter,
  EmailSendInput,
  EmailSendResult,
} from './email-adapter';
export {
  SMTP_EMAIL_DEFAULTS,
  SmtpEmailAdapter,
  classifySmtpEmailResult,
  classifySmtpError,
  createNodemailerSmtpTransport,
  readSmtpEmailConfig,
  sanitizeSmtpError,
} from './smtp-email-adapter';
export type {
  SmtpEmailAdapterOptions,
  SmtpEmailConfig,
  SmtpEmailMessage,
  SmtpEmailTransportResult,
  SmtpTransport,
} from './smtp-email-adapter';
export {
  emailDeliveryNotFoundError,
  emailRecipientNotFoundError,
} from './email-delivery.errors';
export { emailDeliveryRepository } from './email-delivery.repository';
export {
  emailDeliveryService,
  getEmailDelivery,
  listEmailDeliveries,
  sanitizeEmailError,
  sendTemplateEmail,
  toPublicEmailDelivery,
} from './email-delivery.service';
export {
  EMAIL_DELIVERY_STATUSES,
  isEmailDeliveryStatus,
} from './email-delivery.types';
export type {
  EmailDeliveryRecord,
  EmailDeliveryStatus,
  NewEmailDelivery,
  PublicEmailDelivery,
  SendTemplateEmailInput,
} from './email-delivery.types';
