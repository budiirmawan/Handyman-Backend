import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { CreateConfigurationPreviewInput } from './configuration-preview.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export const parsePreviewConfigurationVersionId = (value: string): string =>
  uuid(value, 'configurationVersionId');
export const parseConfigurationPreviewId = (value: string): string =>
  uuid(value, 'configurationPreviewId');

export function parseCreateConfigurationPreviewBody(
  body: unknown,
): CreateConfigurationPreviewInput {
  if (body === undefined || body === null) return { expiresInMinutes: 15 };
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: { field: string; message: string }[] = [];
  for (const field of Object.keys(body)) {
    if (field !== 'expiresInMinutes') {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const expiresInMinutes = body.expiresInMinutes ?? 15;
  if (
    !Number.isInteger(expiresInMinutes) ||
    Number(expiresInMinutes) < 1 ||
    Number(expiresInMinutes) > 120
  ) {
    details.push({
      field: 'expiresInMinutes',
      message: 'expiresInMinutes must be an integer between 1 and 120.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { expiresInMinutes: Number(expiresInMinutes) };
}
