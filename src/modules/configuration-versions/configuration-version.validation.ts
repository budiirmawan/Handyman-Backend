import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CONFIGURATION_VERSION_SOURCE_TYPES,
  type ConfigurationVersionSourceType,
} from './configuration-version.types';

function uuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export function parseConfigurationVersionSourceType(
  value: string,
): ConfigurationVersionSourceType {
  const normalized = value.trim().toUpperCase();
  if (
    !(CONFIGURATION_VERSION_SOURCE_TYPES as readonly string[]).includes(
      normalized,
    )
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'sourceType',
        message: `sourceType must be one of: ${CONFIGURATION_VERSION_SOURCE_TYPES.join(', ')}.`,
      },
    ]);
  }
  return normalized as ConfigurationVersionSourceType;
}

export const parseSourceConfigurationId = (value: string): string =>
  uuid(value, 'sourceConfigurationId');
export const parseConfigurationVersionId = (value: string): string =>
  uuid(value, 'configurationVersionId');
