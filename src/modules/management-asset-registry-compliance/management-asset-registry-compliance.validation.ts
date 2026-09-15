import { AppError } from '../../shared/errors';
import { parseManagementReadScopeQuery } from '../management-read-scope';
import type { ManagementAssetRegistryComplianceQuery } from './management-asset-registry-compliance.types';

export const DEFAULT_COMPLIANCE_EXPIRING_DAYS = 30;
const MAX_COMPLIANCE_EXPIRING_DAYS = 365;

/** Registry/compliance is an as-of snapshot; PART 01 owns only its scope. */
export function parseManagementAssetRegistryComplianceQuery(
  query: Record<string, unknown>,
): ManagementAssetRegistryComplianceQuery {
  const scope = parseManagementReadScopeQuery({
    clientId: query.clientId,
    buildingId: query.buildingId,
    buildingIds: query.buildingIds,
  });

  let expiringWithinDays = DEFAULT_COMPLIANCE_EXPIRING_DAYS;
  const raw = query.expiringWithinDays;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (Array.isArray(raw)) {
      throwInvalidExpiringDays();
    }
    const parsed = Number(raw);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_COMPLIANCE_EXPIRING_DAYS
    ) {
      throwInvalidExpiringDays();
    }
    expiringWithinDays = parsed;
  }

  return { scope, expiringWithinDays };
}

function throwInvalidExpiringDays(): never {
  throw AppError.validation('Request validation failed.', [
    {
      field: 'expiringWithinDays',
      message: `expiringWithinDays must be an integer between 0 and ${MAX_COMPLIANCE_EXPIRING_DAYS}.`,
    },
  ]);
}
