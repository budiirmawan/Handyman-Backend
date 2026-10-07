import { AppError } from '../../shared/errors';
import { notificationTemplateRepository } from './notification-template.repository';
import {
  notificationTemplateKeyAlreadyExistsError,
  notificationTemplateNotFoundError,
} from './notification-template.errors';
import {
  validateTemplateVariableConsistency,
} from './notification-template.validation';
import {
  extractTemplateVariables,
  type CreateNotificationTemplateInput,
  type NotificationTemplateRecord,
  type PublicNotificationTemplate,
  type RenderedNotificationTemplate,
  type UpdateNotificationTemplateInput,
} from './notification-template.types';

/**
 * BE-26B — Notification template service.
 *
 * The reusable template foundation:
 *   - CRUD for template records (platform configuration),
 *   - `renderTemplate` — pure placeholder substitution (the rendering
 *     primitive later BE-26 parts use when reacting to operational events),
 *   - `getActiveTemplateByKey` — ACTIVE template lookup by key.
 *
 * No recipient resolution and no sending here.
 */

export function toPublicNotificationTemplate(
  record: NotificationTemplateRecord,
): PublicNotificationTemplate {
  return {
    id: record.id,
    key: record.key,
    type: record.type,
    channel: record.channel,
    subject: record.subject,
    body: record.body,
    variables: record.variables,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === '23505'
  );
}

/**
 * Renders a template's subject/body with the supplied variable values.
 * Pure — no persistence and no delivery. Every `{{variable}}` placeholder
 * must have a value; extra values are ignored.
 */
export function renderTemplate(
  template: Pick<NotificationTemplateRecord, 'subject' | 'body'>,
  values: Record<string, string | number>,
): RenderedNotificationTemplate {
  const used = new Set([
    ...extractTemplateVariables(template.subject),
    ...(template.body ? extractTemplateVariables(template.body) : []),
  ]);
  const missing = [...used].filter(
    (name) => values[name] === undefined || values[name] === null,
  );
  if (missing.length > 0) {
    throw AppError.validation(
      'Request validation failed.',
      missing.map((name) => ({
        field: `variables.${name}`,
        message: `Missing value for template variable '${name}'.`,
      })),
    );
  }

  const substitute = (text: string): string =>
    text.replace(
      /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
      (_match, name: string) => String(values[name]),
    );

  return {
    subject: substitute(template.subject),
    body: template.body ? substitute(template.body) : null,
  };
}

export async function createNotificationTemplate(
  input: CreateNotificationTemplateInput,
): Promise<PublicNotificationTemplate> {
  try {
    const record = await notificationTemplateRepository.create(input);
    return toPublicNotificationTemplate(record);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw notificationTemplateKeyAlreadyExistsError();
    }
    throw error;
  }
}

export async function listNotificationTemplates(
  status?: NotificationTemplateRecord['status'],
): Promise<PublicNotificationTemplate[]> {
  const rows = await notificationTemplateRepository.list(status);
  return rows.map(toPublicNotificationTemplate);
}

export async function getNotificationTemplate(
  id: string,
): Promise<PublicNotificationTemplate> {
  const record = await notificationTemplateRepository.findById(id);
  if (!record) {
    throw notificationTemplateNotFoundError(id);
  }
  return toPublicNotificationTemplate(record);
}

export async function updateNotificationTemplate(
  id: string,
  input: UpdateNotificationTemplateInput,
): Promise<PublicNotificationTemplate> {
  const existing = await notificationTemplateRepository.findById(id);
  if (!existing) {
    throw notificationTemplateNotFoundError(id);
  }

  // Merge with the existing content, then re-validate placeholder/variable
  // consistency on the merged subject/body/variables.
  const mergedSubject = input.subject ?? existing.subject;
  const mergedBody = input.body !== undefined ? input.body : existing.body;
  const mergedVariables = input.variables ?? existing.variables;
  validateTemplateVariableConsistency(mergedSubject, mergedBody, mergedVariables);

  const record = await notificationTemplateRepository.update(id, input);
  if (!record) {
    throw notificationTemplateNotFoundError(id);
  }
  return toPublicNotificationTemplate(record);
}

/**
 * Returns the ACTIVE template for a key, or null when absent/inactive.
 * The lookup seam BE-26D uses without coupling to HTTP.
 */
export async function getActiveTemplateByKey(
  key: string,
): Promise<PublicNotificationTemplate | null> {
  const record = await notificationTemplateRepository.findByKey(key);
  if (!record || record.status !== 'ACTIVE') {
    return null;
  }
  return toPublicNotificationTemplate(record);
}

export const notificationTemplateService = {
  createNotificationTemplate,
  getActiveTemplateByKey,
  getNotificationTemplate,
  listNotificationTemplates,
  renderTemplate,
  toPublicNotificationTemplate,
  updateNotificationTemplate,
};
