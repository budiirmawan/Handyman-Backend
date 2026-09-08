import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CONFIGURATION_VERSION_SOURCE_TYPES,
  type ConfigurationVersionSourceType,
} from '../configuration-versions/configuration-version.types';
import {
  CONFIGURATION_AUDIT_ACTIONS,
  type ConfigurationAuditAction,
  type ConfigurationAuditFilters,
} from './configuration-audit.types';

function single(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a single string value.` },
    ]);
  }
  return value.trim();
}

function uuid(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export const parseConfigurationAuditId = (value: string): string =>
  uuid(value.trim(), 'configurationAuditEventId');

function date(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid date-time.` },
    ]);
  }
  return parsed;
}

export function parseConfigurationAuditFilters(
  query: Record<string, unknown>,
): ConfigurationAuditFilters {
  const configurationIdValue = single(query.configurationId, 'configurationId');
  const versionIdValue = single(
    query.configurationVersionId,
    'configurationVersionId',
  );
  const buildingIdValue = single(query.buildingId, 'buildingId');
  const sourceValue = single(query.sourceType, 'sourceType')?.toUpperCase();
  const actionValue = single(query.action, 'action')?.toUpperCase();
  if (
    sourceValue &&
    !(CONFIGURATION_VERSION_SOURCE_TYPES as readonly string[]).includes(sourceValue)
  ) {
    throw AppError.validation('Request validation failed.', [
      { field: 'sourceType', message: 'sourceType is invalid.' },
    ]);
  }
  if (
    actionValue &&
    !(CONFIGURATION_AUDIT_ACTIONS as readonly string[]).includes(actionValue)
  ) {
    throw AppError.validation('Request validation failed.', [
      { field: 'action', message: 'action is invalid.' },
    ]);
  }
  const from = date(single(query.from, 'from'), 'from');
  const to = date(single(query.to, 'to'), 'to');
  if (from && to && from > to) {
    throw AppError.validation('Request validation failed.', [
      { field: 'from', message: 'from must not be after to.' },
    ]);
  }
  return {
    ...(configurationIdValue
      ? { configurationId: uuid(configurationIdValue, 'configurationId') }
      : {}),
    ...(versionIdValue
      ? {
          configurationVersionId: uuid(
            versionIdValue,
            'configurationVersionId',
          ),
        }
      : {}),
    ...(buildingIdValue
      ? { buildingId: uuid(buildingIdValue, 'buildingId') }
      : {}),
    ...(sourceValue
      ? { sourceType: sourceValue as ConfigurationVersionSourceType }
      : {}),
    ...(actionValue
      ? { action: actionValue as ConfigurationAuditAction }
      : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}
