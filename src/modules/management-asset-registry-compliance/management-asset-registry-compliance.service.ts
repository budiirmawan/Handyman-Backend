import { isCurrentlyEffective } from '../asset-certifications';
import { isCurrentlyCovered } from '../asset-warranties';
import { ASSET_STATUSES, type AssetStatus } from '../assets';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { managementAssetRegistryComplianceRepository } from './management-asset-registry-compliance.repository';
import type {
  AssetCertificationComplianceRow,
  AssetWarrantyComplianceRow,
} from './management-asset-registry-compliance.repository';
import type {
  ManagementAssetRegistryComplianceQuery,
  PublicManagementAssetRegistryCompliance,
} from './management-asset-registry-compliance.types';

/** BE-24 PART 05A — registry/compliance snapshot only; no maintenance KPI. */
export async function getManagementAssetRegistryCompliance(
  query: ManagementAssetRegistryComplianceQuery,
  userId: string,
): Promise<PublicManagementAssetRegistryCompliance> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context } = resolved;
  const filters = { expiringWithinDays: query.expiringWithinDays };
  const rows =
    await managementAssetRegistryComplianceRepository.getAssetRegistryComplianceRows(
      context.scope.buildingIds,
    );
  const onDate = context.asOf.slice(0, 10);
  const expiringThrough = addUtcDays(onDate, query.expiringWithinDays);

  const assetStatus = emptyAssetStatus();
  for (const asset of rows.assets) assetStatus[asset.status] += 1;

  const coveredAssetIds = new Set(
    rows.warranties
      .filter((record) => isCurrentlyCovered(record, onDate))
      .map((record) => record.assetId),
  );
  const warrantyStatus = countWarrantyStatuses(rows.warranties);

  const effectiveCertifications = rows.certifications.filter((record) =>
    isCurrentlyEffective(record, onDate),
  );
  const effectiveAssetIds = new Set(
    effectiveCertifications.map((record) => record.assetId),
  );
  const certificationStatus = countCertificationStatuses(rows.certifications);
  const expiredComplianceCount = rows.certifications.filter((record) => {
    const expiry = dateString(record.expiryDate);
    return record.status !== 'INACTIVE' && expiry !== null && expiry < onDate;
  }).length;
  const expiringComplianceCount = effectiveCertifications.filter((record) => {
    const expiry = dateString(record.expiryDate);
    return expiry !== null && expiry >= onDate && expiry <= expiringThrough;
  }).length;

  return createManagementReadModelContract(context, filters, {
    totalAssets: rows.assets.length,
    activeAssets: assetStatus.ACTIVE,
    inactiveAssets: assetStatus.INACTIVE,
    assetStatus,
    warranties: {
      totalRecords: rows.warranties.length,
      ...warrantyStatus,
      currentlyCoveredAssets: coveredAssetIds.size,
      assetsWithoutCurrentCoverage: rows.assets.length - coveredAssetIds.size,
    },
    certifications: {
      totalRecords: rows.certifications.length,
      ...certificationStatus,
      currentlyEffectiveRecords: effectiveCertifications.length,
      assetsWithEffectiveCertification: effectiveAssetIds.size,
      assetsWithoutEffectiveCertification:
        rows.assets.length - effectiveAssetIds.size,
      expiredComplianceCount,
      expiringComplianceCount,
    },
    locations: rows.locations,
  });
}

function emptyAssetStatus(): Record<AssetStatus, number> {
  return Object.fromEntries(ASSET_STATUSES.map((status) => [status, 0])) as Record<
    AssetStatus,
    number
  >;
}

function countWarrantyStatuses(records: AssetWarrantyComplianceRow[]) {
  return records.reduce(
    (counts, record) => {
      counts[record.status.toLowerCase() as 'active' | 'expired' | 'inactive'] +=
        1;
      return counts;
    },
    { active: 0, expired: 0, inactive: 0 },
  );
}

function countCertificationStatuses(records: AssetCertificationComplianceRow[]) {
  return records.reduce(
    (counts, record) => {
      counts[record.status.toLowerCase() as 'active' | 'expired' | 'inactive'] +=
        1;
      return counts;
    },
    { active: 0, expired: 0, inactive: 0 },
  );
}

function dateString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function addUtcDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

export const managementAssetRegistryComplianceService = {
  getManagementAssetRegistryCompliance,
};
