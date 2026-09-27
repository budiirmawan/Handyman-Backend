import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
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

export const handymanServiceRequestRepository = {
  insertRequest,
  findById,
  findByChannelAttribution,
};
