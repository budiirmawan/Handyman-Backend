import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import type { CareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanCustomerCareServiceRequestRecord,
  HandymanServiceRequestListFilters,
  HandymanServiceRequestRecord,
  NewHandymanServiceRequest,
} from './handyman-service-request.types';

/**
 * CR-HM-02 PART 03 — Handyman request repository (executor-first
 * convention, INSERT-once intake foundation; rows are never updated by this
 * PART). The channel_attribution_id UNIQUE constraint enforces one request
 * per immutable attribution.
 */

const REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  channel_attribution_id AS "channelAttributionId",
  tenant_company_id AS "tenantCompanyId",
  tenant_pic_id AS "tenantPicId",
  building_id AS "buildingId",
  space_id AS "spaceId",
  service_catalog_id AS "serviceCatalogId",
  service_variant_id AS "serviceVariantId",
  origin_channel AS "originChannel",
  origin_reference AS "originReference",
  description,
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/**
 * CR-HM-17 GAP PART 01 — Customer Care request read projection SELECT.
 * Joins the immutable `handyman_channel_attributions` row for Backend-resolved
 * attribution/care-actor provenance and left-joins `handyman_execution_scopes`
 * for the execution-scope pointer where present.
 */
const CUSTOMER_CARE_PROJECTION_SELECT = `
  r.id,
  r.client_id AS "clientId",
  r.channel_attribution_id AS "channelAttributionId",
  r.tenant_company_id AS "tenantCompanyId",
  r.tenant_pic_id AS "tenantPicId",
  r.building_id AS "buildingId",
  r.space_id AS "spaceId",
  r.service_catalog_id AS "serviceCatalogId",
  r.service_variant_id AS "serviceVariantId",
  ca.origin_channel AS "originChannel",
  ca.origin_reference AS "originReference",
  r.description,
  r.status,
  ca.created_by_user_id AS "createdByUserId",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt",
  ca.actor_type AS "actorType",
  ca.care_actor_id AS "careActorId",
  ca.actor_reference AS "actorReference",
  ca.created_at AS "attributionCreatedAt",
  es.id AS "executionScopeId"
`;

const CUSTOMER_CARE_PROJECTION_FROM = `
  FROM handyman_service_requests r
  JOIN handyman_channel_attributions ca
    ON ca.id = r.channel_attribution_id
   AND ca.client_id = r.client_id
  LEFT JOIN handyman_execution_scopes es
    ON es.handyman_request_id = r.id
   AND es.client_id = r.client_id
`;

async function insertRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  request: NewHandymanServiceRequest,
): Promise<HandymanServiceRequestRecord> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `INSERT INTO handyman_service_requests
       (id, client_id, channel_attribution_id, tenant_company_id,
        tenant_pic_id, building_id, space_id, service_catalog_id,
        service_variant_id, origin_channel, origin_reference, description,
        status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'INTAKE', $13)
     RETURNING ${REQUEST_SELECT}`,
    [
      randomUUID(),
      request.clientId,
      request.channelAttributionId,
      request.tenantCompanyId,
      request.tenantPicId,
      request.buildingId,
      request.spaceId,
      request.serviceCatalogId,
      request.serviceVariantId,
      request.originChannel,
      request.originReference,
      request.description,
      request.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `SELECT ${REQUEST_SELECT} FROM handyman_service_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByChannelAttribution(
  executor: Pick<PoolClient, 'query'> = getPool(),
  channelAttributionId: string,
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `SELECT ${REQUEST_SELECT} FROM handyman_service_requests
      WHERE channel_attribution_id = $1`,
    [channelAttributionId],
  );
  return result.rows[0] ?? null;
}

/**
 * CR-HM-03 PART 01 — bounded F1 projection support. Row-level lock for the
 * atomic "lock request → append triage/journal → project bounded status"
 * transaction (one transition chain per request, ever).
 */
async function lockById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `SELECT ${REQUEST_SELECT} FROM handyman_service_requests
      WHERE id = $1
      FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Bounded F1 projection: the ONLY status mutation pathway introduced for
 * the request row. It never touches any other column; business-context
 * snapshot columns are immutable from CR-HM-02 PART 03 onward.
 */
async function updateStatus(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: HandymanServiceRequestRecord['status'],
): Promise<HandymanServiceRequestRecord | null> {
  const result = await executor.query<HandymanServiceRequestRecord>(
    `UPDATE handyman_service_requests
        SET status = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${REQUEST_SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

/**
 * C6 read wall, applied in SQL to both list and detail so filtering and the
 * returned projection observe the same database statement. A Building/Client
 * assignment alone is NOT customer authority. A linked ACTIVE PIC may read
 * only its represented tenant's requests while the tenant still has effective
 * building + (when selected) exact unit occupancy. Building-only requests
 * require effective occupancy somewhere in the represented building.
 *
 * The existing PLATFORM_ADMIN role is the explicit operational exception:
 * it may read historical requests, but only in its assigned Building and
 * with the route's tenant_company.read permission. No new role/permission.
 */
function customerRequestReadScope(actorParam: number): string {
  const actor = `$${actorParam}`;
  return `EXISTS (
    SELECT 1 FROM user_building_assignments uba
      JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
      JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
      JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
    WHERE uba.user_id = ${actor} AND uba.status = 'ACTIVE'
      AND b.id = r.building_id AND c.id = r.client_id
      AND (
        EXISTS (
          SELECT 1 FROM user_role_assignments ura
            JOIN roles role ON role.id = ura.role_id
          WHERE ura.user_id = ${actor} AND ura.status = 'ACTIVE'
            AND role.code = 'PLATFORM_ADMIN' AND role.status = 'ACTIVE'
        )
        OR (
          EXISTS (
            SELECT 1 FROM tenant_pics pic
              JOIN tenant_companies tc ON tc.id = pic.tenant_company_id
            WHERE pic.user_id = ${actor} AND pic.status = 'ACTIVE'
              AND tc.id = r.tenant_company_id AND tc.client_id = r.client_id
              AND tc.status = 'ACTIVE'
          )
          AND EXISTS (
            SELECT 1 FROM tenant_building_contexts tbc
            WHERE tbc.tenant_company_id = r.tenant_company_id
              AND tbc.building_id = r.building_id AND tbc.status = 'ACTIVE'
              AND (tbc.effective_from IS NULL OR tbc.effective_from <= statement_timestamp())
              AND (tbc.effective_until IS NULL OR tbc.effective_until >= statement_timestamp())
          )
          AND EXISTS (
            SELECT 1 FROM tenant_space_relationships tsr
            WHERE tsr.tenant_company_id = r.tenant_company_id
              AND tsr.building_id = r.building_id AND tsr.status = 'ACTIVE'
              AND (tsr.effective_from IS NULL OR tsr.effective_from <= statement_timestamp())
              AND (tsr.effective_until IS NULL OR tsr.effective_until >= statement_timestamp())
              AND (r.space_id IS NULL OR tsr.space_id = r.space_id)
          )
          AND (r.space_id IS NULL OR EXISTS (
            SELECT 1 FROM spaces s
              JOIN rooms room ON room.id = s.room_id
              JOIN areas a ON a.id = room.area_id
              JOIN floors f ON f.id = a.floor_id
            WHERE s.id = r.space_id AND f.building_id = r.building_id
          ))
        )
      )
  )`;
}

async function findCustomerCareProjectionById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
  actorUserId: string,
): Promise<HandymanCustomerCareServiceRequestRecord | null> {
  const result =
    await executor.query<HandymanCustomerCareServiceRequestRecord>(
      `SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
         ${CUSTOMER_CARE_PROJECTION_FROM}
        WHERE r.id = $1 AND ${customerRequestReadScope(2)}`,
      [id, actorUserId],
    );
  return result.rows[0] ?? null;
}

async function listCustomerCareProjectionsScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: HandymanServiceRequestListFilters,
  actorUserId: string,
): Promise<HandymanCustomerCareServiceRequestRecord[]> {
  const conditions: string[] = ['r.client_id = $1'];
  const values: unknown[] = [filters.clientId];
  let idx = 2;

  if (filters.tenantCompanyId !== undefined) {
    conditions.push(`r.tenant_company_id = $${idx++}`);
    values.push(filters.tenantCompanyId);
  }
  if (filters.buildingId !== undefined) {
    conditions.push(`r.building_id = $${idx++}`);
    values.push(filters.buildingId);
  }
  if (filters.spaceId !== undefined) {
    conditions.push(`r.space_id = $${idx++}`);
    values.push(filters.spaceId);
  }
  if (filters.channelAttributionId !== undefined) {
    conditions.push(`r.channel_attribution_id = $${idx++}`);
    values.push(filters.channelAttributionId);
  }
  if (filters.status !== undefined) {
    conditions.push(`r.status = $${idx++}`);
    values.push(filters.status);
  }
  conditions.push(customerRequestReadScope(idx));
  values.push(actorUserId);

  const result =
    await executor.query<HandymanCustomerCareServiceRequestRecord>(
      `SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
         ${CUSTOMER_CARE_PROJECTION_FROM}
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at ASC, r.id ASC`,
      values,
    );
  return result.rows;
}

export type WorkspaceRequestSelection = {
  propertyId: string; tenantCompanyId: string; buildingId: string; spaceId: string | null;
  status: HandymanServiceRequestListFilters['status'] | null;
  channelAttributionId: string | null;
  limit: number; afterId: string | null; afterCreatedAt: string | null;
};

type WorkspaceRequestRow = HandymanCustomerCareServiceRequestRecord & { cursorCreatedAt: string };
type JsonWorkspaceRequestRow = Omit<WorkspaceRequestRow, 'createdAt' | 'updatedAt' | 'attributionCreatedAt'> & {
  createdAt: string; updatedAt: string; attributionCreatedAt: string;
};

/** Workspace read adapter, NOT the local User/PIC/admin read wall. Reuse the
 * exact existing request projection and current occupancy authority. Every row
 * must match the selected tenant/building AND its applicable current occupancy,
 * including when no space filter is provided. Authorization precedes keyset
 * pagination, in the same statement snapshot; no post-page redaction/counts. */
async function listWorkspaceProjectionsScoped(principal: CareWorkspacePrincipal, selection: WorkspaceRequestSelection) {
  const result = await getPool().query<{
    authenticated: boolean; accessible: boolean; evaluatedAt: Date; items: JsonWorkspaceRequestRow[];
  }>(`
    ${WORKSPACE_OCCUPANCY_CTES}, page AS (
      SELECT ${CUSTOMER_CARE_PROJECTION_SELECT},
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
      ${CUSTOMER_CARE_PROJECTION_FROM}
      WHERE EXISTS (
        SELECT 1 FROM records c WHERE c."clientId" = r.client_id
          AND c."tenantCompanyId" = r.tenant_company_id AND c."buildingId" = r.building_id
          AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      )
        AND ($11::text IS NULL OR r.status = $11)
        AND ($12::uuid IS NULL OR r.channel_attribution_id = $12)
        AND ($5::uuid IS NULL OR (r.created_at, r.id) < ($10::timestamptz, $5::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $6
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      EXISTS(SELECT 1 FROM records) AS accessible,
      statement_timestamp() AS "evaluatedAt",
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page."createdAt" DESC, page.id DESC)
        FROM page), '[]'::jsonb) AS items`,
    [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
      selection.afterId, selection.limit + 1, selection.tenantCompanyId, selection.buildingId,
      selection.spaceId, selection.afterCreatedAt, selection.status, selection.channelAttributionId]);
  const row = result.rows[0];
  // Existing public projector consumes the domain's Date-valued record. The
  // separate cursor key preserves PostgreSQL microseconds (JS Date cannot).
  return { ...row, items: row.items.map(item => ({ ...item,
    createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
    attributionCreatedAt: new Date(item.attributionCreatedAt),
  })) };
}

/** Detail uses the same represented-context authority as PART 06A. The ID
 * never authenticates a request: match scope/occupancy and project together,
 * without an unscoped existence lookup or the local admin historical wall. */
async function findWorkspaceProjectionById(principal: CareWorkspacePrincipal, requestId: string,
  selection: Pick<WorkspaceRequestSelection, 'propertyId' | 'tenantCompanyId' | 'buildingId' | 'spaceId'>) {
  const result = await getPool().query<{
    authenticated: boolean; item: Omit<JsonWorkspaceRequestRow, 'cursorCreatedAt'> | null;
  }>(`
    ${WORKSPACE_OCCUPANCY_CTES}, matched AS (
      SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
      ${CUSTOMER_CARE_PROJECTION_FROM}
      WHERE r.id = $5 AND EXISTS (
        SELECT 1 FROM records c WHERE c."clientId" = r.client_id
          AND c."tenantCompanyId" = r.tenant_company_id AND c."buildingId" = r.building_id
          AND c."spaceId" IS NOT DISTINCT FROM r.space_id
      ) LIMIT $6
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      (SELECT to_jsonb(matched) FROM matched) AS item`,
    [principal.sessionId, principal.careActorId, principal.integrationId, selection.propertyId,
      requestId, 1, selection.tenantCompanyId, selection.buildingId, selection.spaceId]);
  const { authenticated, item } = result.rows[0];
  return { authenticated, item: item ? { ...item,
    createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt),
    attributionCreatedAt: new Date(item.attributionCreatedAt),
  } : null };
}

export const handymanServiceRequestRepository = {
  insertRequest,
  findById,
  findByChannelAttribution,
  lockById,
  updateStatus,
  findCustomerCareProjectionById,
  listCustomerCareProjectionsScoped,
  listWorkspaceProjectionsScoped,
  findWorkspaceProjectionById,
};
