import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { getActiveTemplateByKey, notificationTemplateNotFoundError, renderTemplate } from '../notification-templates';
import { whatsappDeliveryRepository } from './whatsapp-delivery.repository';
import {
  whatsappDeliveryNotFoundError,
  whatsappRecipientNotFoundError,
} from './whatsapp-delivery.errors';
import {
  resolveWhatsAppAdapter,
  type WhatsAppAdapter,
} from './whatsapp-adapter';
import type {
  PublicWhatsAppDelivery,
  SendTemplateWhatsAppInput,
  WhatsAppDeliveryRecord,
} from './whatsapp-delivery.types';

/**
 * BE-26G — WhatsApp delivery service.
 *
 * Adapter-ready WhatsApp delivery:
 *   - validate the recipient (existing ACTIVE user) and phone number,
 *   - render the message from a BE-26B template (ACTIVE only),
 *   - send through a `WhatsAppAdapter` (default: credential-less noop),
 *   - record the delivery attempt (status, sent_at, provider reference,
 *     sanitized failure/error).
 *
 * No provider-specific logic, no Reminder/Escalation, and no duplication of
 * the notification workflow (BE-26D/E remain the event→subscription
 * authority).
 */

const MAX_ERROR_LENGTH = 500;
const PHONE_PATTERN = /^\+?[1-9][0-9]{6,14}$/;
const SECRET_PATTERN =
  /(password|passwd|pwd|secret|api[_-]?key|token|authorization|bearer|auth[_-]?token)\s*[:=]\s*[^\s,;"']+/gi;

/**
 * Redacts credential/token-like values from provider error messages before
 * they are persisted (and never logs them).
 */
export function sanitizeWhatsAppError(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '$1=[REDACTED]');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

export function toPublicWhatsAppDelivery(
  record: WhatsAppDeliveryRecord,
): PublicWhatsAppDelivery {
  return {
    id: record.id,
    clientId: record.clientId,
    recipientUserId: record.recipientUserId,
    recipientPhone: record.recipientPhone,
    templateKey: record.templateKey,
    messageBody: record.messageBody,
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
  recipientPhone: string;
  templateKey: string;
  variables: Record<string, string | number>;
};

function validateSendInput(input: SendTemplateWhatsAppInput): NormalizedSendInput {
  const details: { field: string; message: string }[] = [];

  if (typeof input.templateKey !== 'string' || input.templateKey.trim().length === 0) {
    details.push({ field: 'templateKey', message: 'templateKey must be a non-empty string.' });
  }
  for (const field of ['clientId', 'recipientUserId'] as const) {
    if (typeof input[field] !== 'string' || !isValidUuid(input[field])) {
      details.push({ field, message: `${field} must be a valid UUID.` });
    }
  }
  if (
    typeof input.recipientPhone !== 'string' ||
    !PHONE_PATTERN.test(input.recipientPhone.trim())
  ) {
    details.push({
      field: 'recipientPhone',
      message: 'recipientPhone must be a valid E.164-ish phone number.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId: input.clientId.trim().toLowerCase(),
    recipientUserId: input.recipientUserId.trim().toLowerCase(),
    recipientPhone: input.recipientPhone.trim(),
    templateKey: input.templateKey.trim(),
    variables: input.variables ?? {},
  };
}

/** Validates the recipient references an existing ACTIVE user. */
async function assertActiveRecipient(userId: string): Promise<void> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw whatsappRecipientNotFoundError();
  }
}

/**
 * Sends a templated WhatsApp message to a resolved recipient and records the
 * delivery attempt. An adapter may be injected for tests; it defaults to the
 * configured adapter (noop unless a provider adapter is implemented).
 *
 * WhatsApp has no separate subject line: the message is the rendered body,
 * falling back to the rendered subject when the template has no body.
 */
export async function sendTemplateWhatsApp(
  input: SendTemplateWhatsAppInput,
  adapter: WhatsAppAdapter = resolveWhatsAppAdapter(),
): Promise<PublicWhatsAppDelivery> {
  const normalized = validateSendInput(input);

  await assertActiveRecipient(normalized.recipientUserId);

  const template = await getActiveTemplateByKey(normalized.templateKey);
  if (!template) {
    throw notificationTemplateNotFoundError(normalized.templateKey);
  }

  const rendered = renderTemplate(
    { subject: template.subject, body: template.body },
    normalized.variables,
  );
  const message = rendered.body ?? rendered.subject;

  const result = await adapter.send({
    to: normalized.recipientPhone,
    message,
  });

  const record = await whatsappDeliveryRepository.create({
    clientId: normalized.clientId,
    recipientUserId: normalized.recipientUserId,
    recipientPhone: normalized.recipientPhone,
    templateKey: normalized.templateKey,
    messageBody: message,
    status: result.status,
    provider: adapter.provider,
    // CR-BE-NOTIFY-PROV-01 PART 01: the normalized provider message id
    // supersedes the free-text reference and is persisted in the existing
    // `provider_reference` column (no schema change).
    providerReference: result.providerMessageId ?? result.providerReference ?? null,
    errorMessage:
      result.status === 'FAILED'
        ? sanitizeWhatsAppError(result.error ?? 'WhatsApp delivery failed.')
        : null,
    sentAt: result.status === 'SENT' ? result.sentAt : null,
  });

  return toPublicWhatsAppDelivery(record);
}

/** Lists the recipient's own WhatsApp delivery attempts (newest first). */
export async function listWhatsAppDeliveries(
  recipientUserId: string,
): Promise<PublicWhatsAppDelivery[]> {
  const rows = await whatsappDeliveryRepository.listByRecipient(recipientUserId);
  return rows.map(toPublicWhatsAppDelivery);
}

/** Returns the recipient's own WhatsApp delivery attempt by id. */
export async function getWhatsAppDelivery(
  recipientUserId: string,
  id: string,
): Promise<PublicWhatsAppDelivery> {
  const record = await whatsappDeliveryRepository.findById(recipientUserId, id);
  if (!record) {
    throw whatsappDeliveryNotFoundError(id);
  }
  return toPublicWhatsAppDelivery(record);
}

export const whatsappDeliveryService = {
  getWhatsAppDelivery,
  listWhatsAppDeliveries,
  sanitizeWhatsAppError,
  sendTemplateWhatsApp,
  toPublicWhatsAppDelivery,
};
