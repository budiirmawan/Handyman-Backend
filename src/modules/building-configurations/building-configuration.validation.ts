import { AppError } from '../../shared/errors';
import {
  parseClientConfigurationFilters,
  parseCreateClientConfigurationBody,
  parseUpdateClientConfigurationBody,
} from '../client-configurations';
import { isValidUuid } from '../clients';
import type {
  BuildingConfigurationFilters,
  CreateBuildingConfigurationInput,
  UpdateBuildingConfigurationInput,
} from './building-configuration.types';

function parseUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized;
}

export function parseBuildingConfigurationBuildingIdParam(value: string): string {
  return parseUuid(value, 'buildingId');
}

export function parseBuildingConfigurationIdParam(value: string): string {
  return parseUuid(value, 'buildingConfigurationId');
}

/** Reuses BE-27A's authoritative key/value/status validation contract. */
export function parseCreateBuildingConfigurationBody(
  body: unknown,
): Omit<CreateBuildingConfigurationInput, 'buildingId'> {
  return parseCreateClientConfigurationBody(body);
}

/** Reuses BE-27A's value/status update contract; scope and key stay immutable. */
export function parseUpdateBuildingConfigurationBody(
  body: unknown,
): UpdateBuildingConfigurationInput {
  return parseUpdateClientConfigurationBody(body);
}

export function parseBuildingConfigurationFilters(
  status: unknown,
): BuildingConfigurationFilters {
  return parseClientConfigurationFilters(status);
}
