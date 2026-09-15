import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidModuleCode, normalizeModuleCode } from '../modules';
import type {
  CreateModuleConfigurationInput,
  UpdateModuleConfigurationInput,
} from './module-configuration.types';

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export function parseModuleConfigurationClientIdParam(value: string): string {
  return parseUuid(value, 'clientId');
}

export function parseModuleConfigurationBuildingIdParam(value: string): string {
  return parseUuid(value, 'buildingId');
}

export function parseModuleConfigurationIdParam(value: string): string {
  return parseUuid(value, 'moduleConfigurationId');
}

function unknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): Detail[] {
  return Object.keys(body)
    .filter((field) => !allowed.includes(field))
    .map((field) => ({ field, message: `${field} is not allowed.` }));
}

export function parseCreateModuleConfigurationBody(
  body: unknown,
): CreateModuleConfigurationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details = unknownFields(body, ['moduleKey', 'enabled']);
  let moduleKey: string | undefined;
  if (typeof body.moduleKey !== 'string') {
    details.push({ field: 'moduleKey', message: 'moduleKey is required.' });
  } else {
    const normalized = normalizeModuleCode(body.moduleKey);
    if (!isValidModuleCode(normalized)) {
      details.push({
        field: 'moduleKey',
        message:
          'moduleKey must be a valid existing Module code (2-64 letters, digits, or underscores).',
      });
    } else {
      moduleKey = normalized;
    }
  }

  if (typeof body.enabled !== 'boolean') {
    details.push({ field: 'enabled', message: 'enabled must be a boolean.' });
  }
  if (details.length > 0 || !moduleKey || typeof body.enabled !== 'boolean') {
    throw AppError.validation('Request validation failed.', details);
  }
  return { moduleKey, enabled: body.enabled };
}

export function parseUpdateModuleConfigurationBody(
  body: unknown,
): UpdateModuleConfigurationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details = unknownFields(body, ['enabled']);
  if (typeof body.enabled !== 'boolean') {
    details.push({ field: 'enabled', message: 'enabled must be a boolean.' });
  }
  if (details.length > 0 || typeof body.enabled !== 'boolean') {
    throw AppError.validation('Request validation failed.', details);
  }
  return { enabled: body.enabled };
}
