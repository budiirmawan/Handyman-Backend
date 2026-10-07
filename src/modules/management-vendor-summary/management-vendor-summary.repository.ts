import { getPool } from '../../database';

/**
 * Counts BE-06 Vendors that are ACTIVE and hold an ACTIVE Vendor-Building
 * relationship in the selected scope. DISTINCT prevents a multi-Building
 * Vendor from being counted more than once.
 */
export async function countActiveVendors(
  buildingIds: string[],
): Promise<number> {
  if (buildingIds.length === 0) return 0;
  const result = await getPool().query<{ count: number }>(
    `SELECT count(DISTINCT v.id)::int AS count
       FROM vendors v
       JOIN vendor_building_relationships vbr ON vbr.vendor_id = v.id
      WHERE v.status = 'ACTIVE'
        AND vbr.status = 'ACTIVE'
        AND vbr.building_id = ANY($1::uuid[])`,
    [buildingIds],
  );
  return result.rows[0]?.count ?? 0;
}

export const managementVendorSummaryRepository = {
  countActiveVendors,
};
