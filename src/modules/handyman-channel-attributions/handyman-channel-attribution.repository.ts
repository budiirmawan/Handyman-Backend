import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanChannelAttributionOriginChannel,
  HandymanChannelAttributionRecord,
  NewHandymanChannelAttribution,
} from './handyman-channel-attribution.types';

/** Default to the shared pool; transactional callers pass a PoolClient. */
function executor(client?: PoolClient): Pool | PoolClient {
  return client ?? getPool();
}

/**
 * CR-HM-01 PART 01 — Handyman Channel Attribution repository.
 *
 * Append-only by contract: create + reads only. There are deliberately NO
 * update or delete functions; the database trigger
 * `handyman_channel_attributions_append_only` additionally rejects any
 * UPDATE/DELETE at the storage layer (ERRCODE 23514).
 */

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", tenant_pic_id AS "tenantPicId",
  building_id AS "buildingId", space_id AS "spaceId",
  origin_channel AS "originChannel", origin_reference AS "originReference",
  created_by_user_id AS "createdByUserId", created_at AS "createdAt"`;

async function create(
  input: NewHandymanChannelAttribution,
  client?: PoolClient,
): Promise<HandymanChannelAttributionRecord> {
  const result = await executor(client).query<HandymanChannelAttributionRecord>(
    `INSERT INTO handyman_channel_attributions
       (id, client_id, tenant_company_id, tenant_pic_id, building_id,
        space_id, origin_channel, origin_reference, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.tenantCompanyId,
      input.tenantPicId,
      input.buildingId,
      input.spaceId,
      input.originChannel,
      input.originReference,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<HandymanChannelAttributionRecord | null> {
  const result = await getPool().query<HandymanChannelAttributionRecord>(
    `SELECT ${SELECT} FROM handyman_channel_attributions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByOriginReference(
  originChannel: HandymanChannelAttributionOriginChannel,
  originReference: string,
  client?: PoolClient,
): Promise<HandymanChannelAttributionRecord | null> {
  const result = await executor(client).query<HandymanChannelAttributionRecord>(
    `SELECT ${SELECT} FROM handyman_channel_attributions
     WHERE origin_channel = $1 AND origin_reference = $2`,
    [originChannel, originReference],
  );
  return result.rows[0] ?? null;
}

export const handymanChannelAttributionRepository = {
  create,
  findById,
  findByOriginReference,
};
