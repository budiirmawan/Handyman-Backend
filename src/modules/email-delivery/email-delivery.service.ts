import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { getActiveTemplateByKey, notificationTemplateNotFoundError, renderTemplate } from '../notification-templates';
import { emailDeliveryRepository } from './email-delivery.repository';
import {
  emailDeliveryNotFoundError,
  emailRecipientNotFoundError,
} from './email-delivery.errors';
import {
  resolveEmailAdapter,
  type EmailAdapter,
} from './email-adapter';
import type {
  EmailDeliveryRecord,
  PublicEmailDelivery,
  SendTemplateEmailInput,
} from './email-delivery.types';

/**
 * BE-26F — Email delivery service.
 *
 * Adapter-ready email delivery:
 *   - resolve the recipient's email address (existing `users.email`),
 *   - render subject/body from a BE-26B template (ACTIVE only),
 *   - send through an `EmailAdapter` (default: credential-less noop),
 *   - record the delivery attempt (status, sent_at, provider reference,
 *     sanitized failure/error).
 *
 * No provider-specific logic, no WhatsApp, and no duplication of the
 * notification workflow (BE-26D/E remain the event→subscription authority).
 */

const MAX_ERROR_LENGTH = 500;
const SECRET_PATTERN =
  /(password|passwd|pwd|secret|api[_-]?key|token|authorization|bearer)\s*[:=]\s*[^\s,;"']+/gi;

/**
 * Redacts credential-like values from provider error messages before they are
 * persisted (and never logs them).
 */
export function sanitizeEmailError(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '$1=[REDACTED]');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

export function toPublicEmailDelivery(
  record: EmailDeliveryRecord,
): PublicEmailDelivery {
  return {
    id: record.id,
    clientId: record.clientId,
    recipientUserId: record.recipientUserId,
    recipientEmail: record.recipientEmail,
    templateKey: record.templateKey,
    subject: record.subject,
    body: record.body,
    status: record.status,
    provider: record.provider,
    providerReference: record.providerReference,
    errorMessage: record.errorMessage,
    sentAt: record.sentAt ? record.sentAt.toISOString() : null,
    deliveryId: record.deliveryId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type NormalizedSendInput = {
  clientId: string;
  recipientUserId: string;
  templateKey: string;
  variables: Record<string, string | number>;
};

function validateSendInput(input: SendTemplateEmailInput): NormalizedSendInput {
  const details: { field: string; message: string }[] = [];

  if (typeof input.templateKey !== 'string' || input.templateKey.trim().length === 0) {
    details.push({ field: 'templateKey', message: 'templateKey must be a non-empty string.' });
  }
  for (const field of ['clientId', 'recipientUserId'] as const) {
    if (typeof input[field] !== 'string' || !isValidUuid(input[field])) {
      details.push({ field, message: `${field} must be a valid UUID.` });
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId: input.clientId.trim().toLowerCase(),
    recipientUserId: input.recipientUserId.trim().toLowerCase(),
    templateKey: input.templateKey.trim(),
    variables: input.variables ?? {},
  };
}

/** Resolves the ACTIVE user's email address (existing identity master). */
async function resolveRecipientEmail(userId: string): Promise<string> {
  const result = await getPool().query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
  const email = result.rows[0]?.email?.trim();
  if (!email) {
    throw emailRecipientNotFoundError();
  }
  return email;
}

/**
 * Sends a templated email to a resolved recipient and records the delivery
 * attempt. An adapter may be injected for tests; it defaults to the
 * configured adapter (noop unless a provider adapter is implemented).
 */
export async function sendTemplateEmail(
  input: SendTemplateEmailInput,
  adapter: EmailAdapter = resolveEmailAdapter(),
): Promise<PublicEmailDelivery> {
  const normalized = validateSendInput(input);

  const recipientEmail = await resolveRecipientEmail(normalized.recipientUserId);

  const template = await getActiveTemplateByKey(normalized.templateKey);
  if (!template) {
    throw notificationTemplateNotFoundError(normalized.templateKey);
  }

  const rendered = renderTemplate(
    { subject: template.subject, body: template.body },
    normalized.variables,
  );

  const result = await adapter.send({
    to: recipientEmail,
    subject: rendered.subject,
    body: rendered.body,
  });

  const record = await emailDeliveryRepository.create({
    clientId: normalized.clientId,
    recipientUserId: normalized.recipientUserId,
    recipientEmail,
    templateKey: normalized.templateKey,
    subject: rendered.subject,
    body: rendered.body,
    status: result.status,
    provider: adapter.provider,
    // CR-BE-NOTIFY-PROV-01 PART 01: the normalized provider message id
    // supersedes the free-text reference and is persisted in the existing
    // `provider_reference` column (no schema change).
    providerReference: result.providerMessageId ?? result.providerReference ?? null,
    errorMessage:
      result.status === 'FAILED'
        ? sanitizeEmailError(result.error ?? 'Email delivery failed.')
        : null,
    sentAt: result.status === 'SENT' ? result.sentAt : null,
  });

  return toPublicEmailDelivery(record);
}

/** Lists the recipient's own email delivery attempts (newest first). */
export async function listEmailDeliveries(
  recipientUserId: string,
): Promise<PublicEmailDelivery[]> {
  const rows = await emailDeliveryRepository.listByRecipient(recipientUserId);
  return rows.map(toPublicEmailDelivery);
}

/** Returns the recipient's own email delivery attempt by id. */
export async function getEmailDelivery(
  recipientUserId: string,
  id: string,
): Promise<PublicEmailDelivery> {
  const record = await emailDeliveryRepository.findById(recipientUserId, id);
  if (!record) {
    throw emailDeliveryNotFoundError(id);
  }
  return toPublicEmailDelivery(record);
}

export const emailDeliveryService = {
  getEmailDelivery,
  listEmailDeliveries,
  sanitizeEmailError,
  sendTemplateEmail,
  toPublicEmailDelivery,
};
