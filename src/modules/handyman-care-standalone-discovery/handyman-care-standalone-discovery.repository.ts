import type { PoolClient } from 'pg';
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

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 04 — Building-session readback of
 * the persisted structured request items.
 *
 * Scope law: the caller has ALREADY proven the exact Building/Client pair
 * with `resolveBuildingCareAuthority` + the active lineage and has resolved
 * the parent request through `findBuildingCareRequestById` (which filters
 * client_id AND building_id). This read therefore keys on the same
 * server-derived clientId plus that proven request id — never on a
 * caller-supplied context — and cannot widen the scope.
 *
 * Projection law: an explicit allow-list. Internal Care Notes live in their
 * own table and are never joined here, so an INTERNAL_ONLY note can never
 * reach this projection. The item `attributeValues` is the EFFECTIVE set the
 * pricing engine reads and `inheritedAttributeValues` is its provenance;
 * `inheritedAttributeCodes` states the provenance explicitly for the client.
 *
 * `executor` lets the create transaction read its OWN uncommitted items, so
 * the POST body and the GET detail speak one vocabulary.
 */
export type StandaloneCareRequestItemRecord = {
  id: string;
  serviceCatalogId: string;
  serviceCode: string;
  serviceName: string;
  serviceVariantId: string | null;
  serviceVariantCode: string | null;
  serviceVariantName: string | null;
  quantity: number;
  uomId: string | null;
  uomCode: string | null;
  uomName: string | null;
  uomSymbol: string | null;
  attributeValues: Record<string, string>;
  inheritedAttributeValues: Record<string, string>;
  itemDescription: string | null;
  accessCondition: string;
  status: 'ACTIVE';
  createdAt: Date;
  updatedAt: Date;
};

/** Bounded exactly like the create contract (at most 50 items per request). */
const MAX_READBACK_ITEMS = 50;

async function listBuildingCareRequestItems(
  clientId: string,
  handymanRequestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<StandaloneCareRequestItemRecord[]> {
  const result = await executor.query<StandaloneCareRequestItemRecord>(
    `SELECT ri.id,
            ri.service_catalog_id AS "serviceCatalogId",
            sc.code AS "serviceCode",
            sc.name AS "serviceName",
            ri.service_variant_id AS "serviceVariantId",
            sv.code AS "serviceVariantCode",
            sv.name AS "serviceVariantName",
            ri.quantity::float8 AS quantity,
            ri.uom_id AS "uomId",
            u.code AS "uomCode",
            u.name AS "uomName",
            u.symbol AS "uomSymbol",
            ri.attribute_values AS "attributeValues",
            ri.inherited_attribute_values AS "inheritedAttributeValues",
            ri.item_description AS "itemDescription",
            ri.access_condition AS "accessCondition",
            ri.status,
            ri.created_at AS "createdAt",
            ri.updated_at AS "updatedAt"
       FROM handyman_service_request_items ri
       JOIN service_catalog sc
         ON sc.id = ri.service_catalog_id
        AND sc.client_id = ri.client_id
       LEFT JOIN handyman_service_variants sv
         ON sv.id = ri.service_variant_id
        AND sv.client_id = ri.client_id
       LEFT JOIN units_of_measure u
         ON u.id = ri.uom_id
        AND u.client_id = ri.client_id
      WHERE ri.client_id = $1
        AND ri.handyman_request_id = $2
        AND ri.status = 'ACTIVE'
      ORDER BY ri.created_at ASC, ri.id ASC
      LIMIT ${MAX_READBACK_ITEMS}`,
    [clientId, handymanRequestId],
  );
  return result.rows;
}

/**
 * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 intake readers.
 *
 * Every query below is keyed by the Server-derived (clientId, buildingId)
 * pair the caller obtained from `resolveBuildingCareAuthority` — the SQL
 * never trusts a caller-supplied Client. Each reader returns only ACTIVE,
 * currently-effective rows, so the response doubles as the eligibility
 * contract for the staff-assisted create.
 */
export type StandaloneCareTenantRecord = {
  id: string;
  tenantCode: string;
  tenantName: string;
  pics: { id: string; picName: string; isPrimary: boolean }[];
};

export type StandaloneCareFloorRecord = {
  id: string;
  code: string;
  name: string;
  levelNumber: number;
};

export type StandaloneCareUnitRecord = {
  id: string;
  code: string;
  name: string;
  floorId: string;
  floorCode: string;
  levelNumber: number;
  roomId: string;
  roomCode: string;
};

/** ACTIVE tenant companies holding an ACTIVE, currently-effective context
 * in this exact Building, with their ACTIVE PICs nested for selection. */
async function listBuildingCareTenants(
  clientId: string,
  buildingId: string,
): Promise<StandaloneCareTenantRecord[]> {
  const result = await getPool().query<StandaloneCareTenantRecord>(`
    SELECT tc.id,
           tc.tenant_code AS "tenantCode",
           tc.tenant_name AS "tenantName",
           COALESCE((
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'id', tp.id,
                        'picName', tp.pic_name,
                        'isPrimary', tp.is_primary
                      )
                      ORDER BY tp.is_primary DESC, tp.pic_name ASC, tp.id ASC
                    )
               FROM tenant_pics tp
              WHERE tp.tenant_company_id = tc.id
                AND tp.status = 'ACTIVE'
           ), '[]'::jsonb) AS pics
      FROM tenant_companies tc
     WHERE tc.client_id = $1
       AND tc.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1
           FROM tenant_building_contexts tbc
          WHERE tbc.tenant_company_id = tc.id
            AND tbc.building_id = $2
            AND tbc.status = 'ACTIVE'
            AND (tbc.effective_from IS NULL
                 OR tbc.effective_from <= statement_timestamp())
            AND (tbc.effective_until IS NULL
                 OR tbc.effective_until >= statement_timestamp())
       )
     ORDER BY tc.tenant_code ASC, tc.id ASC`,
    [clientId, buildingId],
  );
  return result.rows;
}

/** ACTIVE Floors of the exact Building — the Tower -> Floor step (the
 * Building itself is the tower scope carried by the route path). */
async function listBuildingCareFloors(
  buildingId: string,
): Promise<StandaloneCareFloorRecord[]> {
  const result = await getPool().query<StandaloneCareFloorRecord>(`
    SELECT f.id,
           f.code,
           f.name,
           f.level_number AS "levelNumber"
      FROM floors f
     WHERE f.building_id = $1
       AND f.status = 'ACTIVE'
     ORDER BY f.level_number ASC, f.id ASC`,
    [buildingId],
  );
  return result.rows;
}

/** Unit (= Space) selection for ONE tenant in the exact Building: only
 * spaces whose ACTIVE, currently-effective tenant relationship and whose
 * full ACTIVE Space -> Room -> Area -> Floor chain resolve inside this
 * Building. Optional floor narrowing keeps the Tower -> Floor -> Unit
 * cascade server-validated end to end. */
async function listBuildingCareUnits(
  clientId: string,
  buildingId: string,
  tenantCompanyId: string,
  floorId?: string,
): Promise<StandaloneCareUnitRecord[]> {
  const values: unknown[] = [clientId, buildingId, tenantCompanyId];
  let floorClause = '';
  if (floorId !== undefined) {
    values.push(floorId);
    floorClause = 'AND f.id = $4';
  }
  const result = await getPool().query<StandaloneCareUnitRecord>(`
    SELECT s.id,
           s.code,
           s.name,
           f.id AS "floorId",
           f.code AS "floorCode",
           f.level_number AS "levelNumber",
           r.id AS "roomId",
           r.code AS "roomCode"
      FROM tenant_space_relationships tsr
      JOIN spaces s ON s.id = tsr.space_id AND s.status = 'ACTIVE'
      JOIN rooms r ON r.id = s.room_id AND r.status = 'ACTIVE'
      JOIN areas a ON a.id = r.area_id AND a.status = 'ACTIVE'
      JOIN floors f ON f.id = a.floor_id AND f.status = 'ACTIVE'
      JOIN tenant_companies tc ON tc.id = tsr.tenant_company_id
     WHERE tc.client_id = $1
       AND tc.status = 'ACTIVE'
       AND tsr.building_id = $2
       AND tsr.tenant_company_id = $3
       AND tsr.status = 'ACTIVE'
       AND (tsr.effective_from IS NULL
            OR tsr.effective_from <= statement_timestamp())
       AND (tsr.effective_until IS NULL
            OR tsr.effective_until >= statement_timestamp())
       AND f.building_id = $2
       ${floorClause}
     ORDER BY f.level_number ASC, s.code ASC, s.id ASC`,
    values,
  );
  return result.rows;
}

export const handymanCareStandaloneDiscoveryRepository = {
  findActiveBuildingLineage,
  findBuildingCareRequestById,
  listBuildingCareRequestItems,
  listActiveBuildingLineages,
  listBuildingCareFloors,
  listBuildingCareRequests,
  listBuildingCareTenants,
  listBuildingCareUnits,
};