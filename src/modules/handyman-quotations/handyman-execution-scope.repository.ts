import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanExecutionScopeRecord,
  NewHandymanExecutionScope,
} from './handyman-execution-scope.types';

/**
 * CR-HM-06 PART 05 — execution scope repository (FROZEN F8/F9).
 * Executor-first; INSERT + bounded reads ONLY. No UPDATE/DELETE —
 * the 0395 trigger refuses them; CR-HM-06 owns no further lifecycle.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  quotation_id: string;
  approved_quotation_version_id: string;
  quotation_decision_id: string;
  tenant_company_id: string;
  tenant_pic_id: string | null;
  building_id: string;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  space_id: string | null;
  status: HandymanExecutionScopeRecord['status'];
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const SCOPE_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         quotation_id, approved_quotation_version_id,
         quotation_decision_id, tenant_company_id, tenant_pic_id,
         building_id, floor_id, area_id, room_id, space_id, status,
         created_by_user_id, created_at, updated_at
    FROM handyman_execution_scopes`;

function map(row: Row): HandymanExecutionScopeRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    quotationId: row.quotation_id,
    approvedQuotationVersionId: row.approved_quotation_version_id,
    quotationDecisionId: row.quotation_decision_id,
    tenantCompanyId: row.tenant_company_id,
    tenantPicId: row.tenant_pic_id,
    buildingId: row.building_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    roomId: row.room_id,
    spaceId: row.space_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertScope(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanExecutionScope,
): Promise<HandymanExecutionScopeRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_execution_scopes (
       id, client_id, handyman_request_id, channel_attribution_id,
       quotation_id, approved_quotation_version_id,
       quotation_decision_id, tenant_company_id, tenant_pic_id,
       building_id, floor_id, area_id, room_id, space_id,
       status, created_by_user_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'AUTHORIZED',$15
     )
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               quotation_id, approved_quotation_version_id,
               quotation_decision_id, tenant_company_id, tenant_pic_id,
               building_id, floor_id, area_id, room_id, space_id, status,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.channelAttributionId,
      input.quotationId,
      input.approvedQuotationVersionId,
      input.quotationDecisionId,
      input.tenantCompanyId,
      input.tenantPicId,
      input.buildingId,
      input.floorId,
      input.areaId,
      input.roomId,
      input.spaceId,
      input.createdByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findScopeByApprovedVersion(
  executor: Pick<PoolClient, 'query'> = getPool(),
  approvedQuotationVersionId: string,
): Promise<HandymanExecutionScopeRecord | null> {
  const result = await executor.query<Row>(
    `${SCOPE_SELECT} WHERE approved_quotation_version_id = $1`,
    [approvedQuotationVersionId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function findScopeById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanExecutionScopeRecord | null> {
  const result = await executor.query<Row>(
    `${SCOPE_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanExecutionScopeRepository = {
  insertScope,
  findScopeByApprovedVersion,
  findScopeById,
};
