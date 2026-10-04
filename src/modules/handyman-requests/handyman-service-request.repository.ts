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

async function findCustomerCareProjectionById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanCustomerCareServiceRequestRecord | null> {
  const result =
    await executor.query<HandymanCustomerCareServiceRequestRecord>(
      `SELECT ${CUSTOMER_CARE_PROJECTION_SELECT}
         ${CUSTOMER_CARE_PROJECTION_FROM}
        WHERE r.id = $1`,
      [id],
    );
  return result.rows[0] ?? null;
}

async function listCustomerCareProjectionsScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: HandymanServiceRequestListFilters,
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

export const handymanServiceRequestRepository = {
  insertRequest,
  findById,
  findByChannelAttribution,
  lockById,
  updateStatus,
  findCustomerCareProjectionById,
  listCustomerCareProjectionsScoped,
};
