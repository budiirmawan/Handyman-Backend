import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidModuleCode, normalizeModuleCode } from '../modules';
import {
  FEATURE_ENTITLEMENT_STATES,
  isFeatureEntitlementState,
  type CreateFeatureEntitlementConfigurationInput,
  type UpdateFeatureEntitlementConfigurationInput,
} from './feature-entitlement-configuration.types';

const FEATURE_KEY_PATTERN = /^[A-Z][A-Z0-9_.-]*$/;
const MAX_FEATURE_KEY_LENGTH = 100;
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

export function parseFeatureEntitlementClientIdParam(value: string): string {
  return parseUuid(value, 'clientId');
}

export function parseFeatureEntitlementBuildingIdParam(value: string): string {
  return parseUuid(value, 'buildingId');
}

export function parseFeatureEntitlementConfigurationIdParam(value: string): string {
  return parseUuid(value, 'featureEntitlementConfigurationId');
}

function unknownFields(body: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(body)
    .filter((field) => !allowed.includes(field))
    .map((field) => ({ field, message: `${field} is not allowed.` }));
}

function readState(value: unknown, details: Detail[]) {
  if (!isFeatureEntitlementState(value)) {
    details.push({
      field: 'state',
      message: `state must be one of: ${FEATURE_ENTITLEMENT_STATES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

export function parseCreateFeatureEntitlementConfigurationBody(
  body: unknown,
): CreateFeatureEntitlementConfigurationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = unknownFields(body, [
    'moduleKey',
    'featureKey',
    'state',
  ]);

  let moduleKey: string | undefined;
  if (typeof body.moduleKey !== 'string') {
    details.push({ field: 'moduleKey', message: 'moduleKey is required.' });
  } else {
    const normalized = normalizeModuleCode(body.moduleKey);
    if (!isValidModuleCode(normalized)) {
      details.push({ field: 'moduleKey', message: 'moduleKey is invalid.' });
    } else {
      moduleKey = normalized;
    }
  }

  let featureKey: string | undefined;
  if (typeof body.featureKey !== 'string' || body.featureKey.trim() === '') {
    details.push({ field: 'featureKey', message: 'featureKey is required.' });
  } else {
    const normalized = body.featureKey.trim().toUpperCase();
    if (
      normalized.length > MAX_FEATURE_KEY_LENGTH ||
      !FEATURE_KEY_PATTERN.test(normalized)
    ) {
      details.push({
        field: 'featureKey',
        message:
          'featureKey must start with a letter and contain only letters, digits, dots, hyphens, or underscores (max 100).',
      });
    } else {
      featureKey = normalized;
    }
  }
  const state = readState(body.state, details);
  if (details.length > 0 || !moduleKey || !featureKey || !state) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { moduleKey, featureKey, state };
}

export function parseUpdateFeatureEntitlementConfigurationBody(
  body: unknown,
): UpdateFeatureEntitlementConfigurationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: Detail[] = unknownFields(body, ['state']);
  const state = readState(body.state, details);
  if (details.length > 0 || !state) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { state };
}
