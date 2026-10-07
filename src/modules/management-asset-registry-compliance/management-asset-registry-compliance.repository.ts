import { getPool } from '../../database';
import type { AssetCertificationRecord } from '../asset-certifications';
import type { AssetWarrantyRecord } from '../asset-warranties';
import type { AssetStatus } from '../assets';
import type { ManagementAssetLocationSummary } from './management-asset-registry-compliance.types';

export type AssetRegistryRow = {
  id: string;
  status: AssetStatus;
};

export type AssetWarrantyComplianceRow = Pick<
  AssetWarrantyRecord,
  'assetId' | 'status' | 'startDate' | 'endDate'
>;

export type AssetCertificationComplianceRow = Pick<
  AssetCertificationRecord,
  'assetId' | 'status' | 'issueDate' | 'expiryDate'
>;

/** Four bounded, set-based reads over authoritative BE-05 tables. */
export async function getAssetRegistryComplianceRows(
  buildingIds: string[],
): Promise<{
  assets: AssetRegistryRow[];
  warranties: AssetWarrantyComplianceRow[];
  certifications: AssetCertificationComplianceRow[];
  locations: ManagementAssetLocationSummary[];
}> {
  if (buildingIds.length === 0) {
    return { assets: [], warranties: [], certifications: [], locations: [] };
  }

  const [assets, warranties, certifications, locations] = await Promise.all([
    getPool().query<AssetRegistryRow>(
      `SELECT a.id, a.status
         FROM assets a
        WHERE a.building_id = ANY($1::uuid[])
        ORDER BY a.id`,
      [buildingIds],
    ),
    getPool().query<AssetWarrantyComplianceRow>(
      `SELECT aw.asset_id AS "assetId", aw.status,
              aw.start_date AS "startDate", aw.end_date AS "endDate"
         FROM asset_warranties aw
         JOIN assets a ON a.id = aw.asset_id
        WHERE a.building_id = ANY($1::uuid[])
        ORDER BY aw.asset_id, aw.start_date`,
      [buildingIds],
    ),
    getPool().query<AssetCertificationComplianceRow>(
      `SELECT ac.asset_id AS "assetId", ac.status,
              ac.issue_date AS "issueDate", ac.expiry_date AS "expiryDate"
         FROM asset_certifications ac
         JOIN assets a ON a.id = ac.asset_id
        WHERE a.building_id = ANY($1::uuid[])
        ORDER BY ac.asset_id, ac.certification_type, ac.issue_date`,
      [buildingIds],
    ),
    getPool().query<{
      building_id: string;
      functional_location_id: string | null;
      functional_location_code: string | null;
      functional_location_name: string | null;
      functional_location_status: string | null;
      asset_count: number;
    }>(
      `SELECT
         a.building_id,
         a.functional_location_id,
         fl.code AS functional_location_code,
         fl.name AS functional_location_name,
         fl.status AS functional_location_status,
         count(*)::int AS asset_count
       FROM assets a
       LEFT JOIN functional_locations fl ON fl.id = a.functional_location_id
       WHERE a.building_id = ANY($1::uuid[])
       GROUP BY a.building_id, a.functional_location_id,
                fl.code, fl.name, fl.status
       ORDER BY a.building_id, fl.code NULLS FIRST, a.functional_location_id`,
      [buildingIds],
    ),
  ]);

  return {
    assets: assets.rows,
    warranties: warranties.rows,
    certifications: certifications.rows,
    locations: locations.rows.map((row) => ({
      buildingId: row.building_id,
      locationType:
        row.functional_location_id === null ? 'BUILDING' : 'FUNCTIONAL_LOCATION',
      functionalLocationId: row.functional_location_id,
      functionalLocationCode: row.functional_location_code,
      functionalLocationName: row.functional_location_name,
      functionalLocationStatus: row.functional_location_status,
      assetCount: row.asset_count,
    })),
  };
}

export const managementAssetRegistryComplianceRepository = {
  getAssetRegistryComplianceRows,
};
