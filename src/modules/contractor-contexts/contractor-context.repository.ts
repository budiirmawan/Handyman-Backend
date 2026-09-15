import { getPool } from '../../database';
import type {
  ContractorContextFilters,
  ContractorContextRecord,
} from './contractor-context.types';

/**
 * Read-only BE-20B projection over BE-06 and BE-14I data. This repository
 * creates no Contractor table and returns only currently Permit-eligible
 * relationships inside the caller's already-resolved Building scope.
 */
async function listEligible(
  filters: ContractorContextFilters,
  accessibleBuildingIds: string[],
): Promise<ContractorContextRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const buildingRef = filters.buildingId ? bind(filters.buildingId) : null;
  const vendorRef = filters.vendorId ? bind(filters.vendorId) : null;
  const tenantRef = filters.tenantCompanyId
    ? bind(filters.tenantCompanyId)
    : null;

  const branches: string[] = [];
  if (
    filters.contractorContextType !== 'TENANT_CONTRACTOR' &&
    !filters.tenantCompanyId
  ) {
    const conditions = [
      'vbr.building_id = ANY($1::uuid[])',
      "vbr.status = 'ACTIVE'",
      '(vbr.effective_from IS NULL OR vbr.effective_from <= NOW())',
      '(vbr.effective_until IS NULL OR vbr.effective_until >= NOW())',
      "v.status = 'ACTIVE'",
      "b.status = 'ACTIVE'",
      "c.status = 'ACTIVE'",
      'v.client_id = p.client_id',
    ];
    if (buildingRef) conditions.push(`vbr.building_id = ${buildingRef}`);
    if (vendorRef) conditions.push(`v.id = ${vendorRef}`);

    branches.push(`
      SELECT
        'VENDOR_CONTRACTOR'::text AS "contractorContextType",
        v.id AS "contractorContextId",
        v.client_id AS "clientId",
        vbr.building_id AS "buildingId",
        v.id AS "vendorId",
        v.vendor_code AS "vendorCode",
        v.vendor_name AS "vendorName",
        vbr.id AS "vendorBuildingRelationshipId",
        NULL::uuid AS "tenantCompanyId",
        NULL::text AS "tenantCode",
        NULL::text AS "tenantName",
        NULL::uuid AS "tenantContractorRelationshipId",
        NULL::uuid AS "spaceId",
        NULL::text AS "relationshipType",
        vbr.effective_from AS "effectiveFrom",
        vbr.effective_until AS "effectiveUntil",
        'ACTIVE'::text AS status
      FROM vendor_building_relationships vbr
      JOIN vendors v ON v.id = vbr.vendor_id
      JOIN buildings b ON b.id = vbr.building_id
      JOIN properties p ON p.id = b.property_id
      JOIN clients c ON c.id = p.client_id
      WHERE ${conditions.join(' AND ')}
    `);
  }

  if (filters.contractorContextType !== 'VENDOR_CONTRACTOR') {
    const conditions = [
      'tcr.building_id = ANY($1::uuid[])',
      "tcr.status = 'ACTIVE'",
      '(tcr.effective_from IS NULL OR tcr.effective_from <= NOW())',
      '(tcr.effective_until IS NULL OR tcr.effective_until >= NOW())',
      "v.status = 'ACTIVE'",
      "vbr.status = 'ACTIVE'",
      '(vbr.effective_from IS NULL OR vbr.effective_from <= NOW())',
      '(vbr.effective_until IS NULL OR vbr.effective_until >= NOW())',
      "tc.status = 'ACTIVE'",
      "b.status = 'ACTIVE'",
      "c.status = 'ACTIVE'",
      'tcr.client_id = p.client_id',
      'v.client_id = p.client_id',
      'tc.client_id = p.client_id',
      `EXISTS (
        SELECT 1 FROM tenant_building_contexts tbc
        WHERE tbc.tenant_company_id = tcr.tenant_company_id
          AND tbc.building_id = tcr.building_id
          AND tbc.status = 'ACTIVE'
          AND (tbc.effective_from IS NULL OR tbc.effective_from <= NOW())
          AND (tbc.effective_until IS NULL OR tbc.effective_until >= NOW())
      )`,
      `(tcr.space_id IS NULL OR EXISTS (
        SELECT 1 FROM tenant_space_relationships tsr
        WHERE tsr.tenant_company_id = tcr.tenant_company_id
          AND tsr.building_id = tcr.building_id
          AND tsr.space_id = tcr.space_id
          AND tsr.status = 'ACTIVE'
          AND (tsr.effective_from IS NULL OR tsr.effective_from <= NOW())
          AND (tsr.effective_until IS NULL OR tsr.effective_until >= NOW())
      ))`,
    ];
    if (buildingRef) conditions.push(`tcr.building_id = ${buildingRef}`);
    if (vendorRef) conditions.push(`v.id = ${vendorRef}`);
    if (tenantRef) conditions.push(`tc.id = ${tenantRef}`);

    branches.push(`
      SELECT
        'TENANT_CONTRACTOR'::text AS "contractorContextType",
        tcr.id AS "contractorContextId",
        tcr.client_id AS "clientId",
        tcr.building_id AS "buildingId",
        v.id AS "vendorId",
        v.vendor_code AS "vendorCode",
        v.vendor_name AS "vendorName",
        vbr.id AS "vendorBuildingRelationshipId",
        tc.id AS "tenantCompanyId",
        tc.tenant_code AS "tenantCode",
        tc.tenant_name AS "tenantName",
        tcr.id AS "tenantContractorRelationshipId",
        tcr.space_id AS "spaceId",
        tcr.relationship_type AS "relationshipType",
        tcr.effective_from AS "effectiveFrom",
        tcr.effective_until AS "effectiveUntil",
        'ACTIVE'::text AS status
      FROM tenant_contractor_relationships tcr
      JOIN vendors v ON v.id = tcr.contractor_vendor_id
      JOIN tenant_companies tc ON tc.id = tcr.tenant_company_id
      JOIN vendor_building_relationships vbr
        ON vbr.vendor_id = v.id AND vbr.building_id = tcr.building_id
      JOIN buildings b ON b.id = tcr.building_id
      JOIN properties p ON p.id = b.property_id
      JOIN clients c ON c.id = p.client_id
      WHERE ${conditions.join(' AND ')}
    `);
  }

  if (branches.length === 0) return [];
  const result = await getPool().query<ContractorContextRecord>(
    `${branches.join(' UNION ALL ')}
     ORDER BY "vendorName", "buildingId", "contractorContextType"`,
    values,
  );
  return result.rows;
}

export const contractorContextRepository = { listEligible };
