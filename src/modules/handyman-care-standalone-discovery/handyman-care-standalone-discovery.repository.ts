import { getPool } from '../../database';
import type { HandymanServiceRequestStatus } from '../handyman-requests';

export type ActiveBuildingLineageRecord = {
  id: string;
  code: string;
  name: string;
  propertyId: string;
  propertyCode: string;
  propertyName: string;
  clientId: string;
};

export type StandaloneCareRequestRecord = {
  id: string;
  buildingId: string;
  spaceId: string | null;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  description: string | null;
  status: HandymanServiceRequestStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Internal join key for the operational projector; never serialized. */
  executionScopeId: string | null;
};

export type StandaloneCareRequestFilters = {
  status?: HandymanServiceRequestStatus;
  spaceId?: string;
};

export type StandaloneCareRequestPage = {
  limit: number;
  offset: number;
};

const BUILDING_LINEAGE_SELECT = `
  SELECT b.id,
         b.code,
         b.name,
         p.id AS "propertyId",
         p.code AS "propertyCode",
         p.name AS "propertyName",
         c.id AS "clientId"
    FROM buildings b
    JOIN properties p ON p.id = b.property_id
    JOIN clients c ON c.id = p.client_id
`;

/**
 * Validates the active Client → Property → Building chain for a set of
 * Buildings already obtained from the canonical user-assignment resolver.
 * The caller cannot provide this set: it comes from resolveBuildingsForUser.
 */
async function listActiveBuildingLineages(
  buildingIds: readonly string[],
): Promise<ActiveBuildingLineageRecord[]> {
  if (buildingIds.length === 0) return [];

  const result = await getPool().query<ActiveBuildingLineageRecord>(
    `${BUILDING_LINEAGE_SELECT}
      WHERE b.id = ANY($1::uuid[])
        AND b.status = 'ACTIVE'
        AND p.status = 'ACTIVE'
        AND c.status = 'ACTIVE'
      ORDER BY b.code ASC, b.id ASC`,
    [buildingIds],
  );
  return result.rows;
}

async function findActiveBuildingLineage(
  buildingId: string,
): Promise<ActiveBuildingLineageRecord | null> {
  const result = await getPool().query<ActiveBuildingLineageRecord>(
    `${BUILDING_LINEAGE_SELECT}
      WHERE b.id = $1
        AND b.status = 'ACTIVE'
        AND p.status = 'ACTIVE'
        AND c.status = 'ACTIVE'
      LIMIT 1`,
    [buildingId],
  );
  return result.rows[0] ?? null;
}

const REQUEST_FROM = `
  FROM handyman_service_requests r
  JOIN handyman_channel_attributions ca
    ON ca.id = r.channel_attribution_id
   AND ca.client_id = r.client_id
   AND ca.tenant_company_id = r.tenant_company_id
   AND ca.tenant_pic_id IS NOT DISTINCT FROM r.tenant_pic_id
   AND ca.building_id = r.building_id
   AND ca.space_id IS NOT DISTINCT FROM r.space_id
  JOIN buildings b
    ON b.id = r.building_id
   AND b.status = 'ACTIVE'
  JOIN properties p
    ON p.id = b.property_id
   AND p.status = 'ACTIVE'
  JOIN clients c
    ON c.id = p.client_id
   AND c.status = 'ACTIVE'
   AND c.id = r.client_id
  LEFT JOIN LATERAL (
    SELECT es.id
      FROM handyman_execution_scopes es
     WHERE es.handyman_request_id = r.id
       AND es.client_id = r.client_id
       AND es.tenant_company_id = r.tenant_company_id
       AND es.building_id = r.building_id
     ORDER BY es.created_at DESC, es.id DESC
     LIMIT 1
  ) es ON TRUE
`;

const REQUEST_SELECT = `
  SELECT r.id,
         r.building_id AS "buildingId",
         r.space_id AS "spaceId",
         r.service_catalog_id AS "serviceCatalogId",
         r.service_variant_id AS "serviceVariantId",
         r.description,
         r.status,
         r.created_at AS "createdAt",
         r.updated_at AS "updatedAt",
         es.id AS "executionScopeId"
  ${REQUEST_FROM}
`;

function requestConditions(
  clientId: string,
  buildingId: string,
  filters: StandaloneCareRequestFilters,
): { sql: string; values: unknown[] } {
  const conditions = ['r.client_id = $1', 'r.building_id = $2'];
  const values: unknown[] = [clientId, buildingId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`r.status = $${values.length}`);
  }
  if (filters.spaceId !== undefined) {
    values.push(filters.spaceId);
    conditions.push(`r.space_id = $${values.length}`);
  }

  return { sql: conditions.join(' AND '), values };
}

function mapRequest(row: {
  id: string;
  buildingId: string;
  spaceId: string | null;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  description: string | null;
  status: HandymanServiceRequestStatus;
  createdAt: Date;
  updatedAt: Date;
  executionScopeId: string | null;
}): StandaloneCareRequestRecord {
  return {
    id: row.id,
    buildingId: row.buildingId,
    spaceId: row.spaceId,
    serviceCatalogId: row.serviceCatalogId,
    serviceVariantId: row.serviceVariantId,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    executionScopeId: row.executionScopeId,
  };
}

async function listBuildingCareRequests(
  clientId: string,
  buildingId: string,
  filters: StandaloneCareRequestFilters,
  page?: StandaloneCareRequestPage,
): Promise<{ items: StandaloneCareRequestRecord[]; total?: number }> {
  const { sql, values } = requestConditions(clientId, buildingId, filters);
  let total: number | undefined;

  if (page) {
    const counted = await getPool().query<{ total: number }>(
      `SELECT count(*)::int AS total ${REQUEST_FROM} WHERE ${sql}`,
      values,
    );
    total = counted.rows[0]?.total ?? 0;
  }

  const pageSql = page
    ? ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`
    : '';
  const pageValues = page ? [...values, page.limit, page.offset] : values;
  const result = await getPool().query(
    `${REQUEST_SELECT}
      WHERE ${sql}
      ORDER BY r.created_at DESC, r.id DESC${pageSql}`,
    pageValues,
  );

  return {
    items: result.rows.map(mapRequest),
    ...(total === undefined ? {} : { total }),
  };
}

async function findBuildingCareRequestById(
  clientId: string,
  buildingId: string,
  requestId: string,
): Promise<StandaloneCareRequestRecord | null> {
  const result = await getPool().query(
    `${REQUEST_SELECT}
      WHERE r.client_id = $1
        AND r.building_id = $2
        AND r.id = $3
      LIMIT 1`,
    [clientId, buildingId, requestId],
  );
  return result.rows[0] ? mapRequest(result.rows[0]) : null;
}

export const handymanCareStandaloneDiscoveryRepository = {
  findActiveBuildingLineage,
  findBuildingCareRequestById,
  listActiveBuildingLineages,
  listBuildingCareRequests,
};