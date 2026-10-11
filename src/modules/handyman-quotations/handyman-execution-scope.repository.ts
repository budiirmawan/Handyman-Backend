import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanExecutionScopeActorType,
  HandymanExecutionScopeRecord,
  NewHandymanExecutionScope,
} from './handyman-execution-scope.types';

/**
 * CR-HM-06 PART 05 — execution scope repository (FROZEN F8/F9).
 * Executor-first; INSERT + bounded reads ONLY. No UPDATE/DELETE —
 * the 0395 trigger refuses them; CR-HM-06 owns no further lifecycle.
 *
 * W03 PART 03F: 0443 supplies the independent INSERT floor (A01 E1–E3).
 * Service preflight uses its predicate in the SAME approval transaction; replay
 * validates stored provenance without renewing expired approval credentials.
 * Historical USER scope reads remain unchanged (A9/E4). No downstream writer
 * or alternate scope-creation path is introduced.
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
  created_by_user_id: string | null;
  created_by_actor_type: HandymanExecutionScopeActorType;
  created_by_tenant_pic_id: string | null;
  created_by_pic_session_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const SCOPE_COLUMNS = `id, client_id, handyman_request_id, channel_attribution_id,
         quotation_id, approved_quotation_version_id,
         quotation_decision_id, tenant_company_id, tenant_pic_id,
         building_id, floor_id, area_id, room_id, space_id, status,
         created_by_user_id, created_by_actor_type,
         created_by_tenant_pic_id, created_by_pic_session_id,
         created_at, updated_at`;

const SCOPE_SELECT = `SELECT ${SCOPE_COLUMNS}
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
    createdByActorType: row.created_by_actor_type,
    createdByTenantPicId: row.created_by_tenant_pic_id,
    createdByPicSessionId: row.created_by_pic_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertScope(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanExecutionScope,
): Promise<HandymanExecutionScopeRecord> {
  const actor = input.actor;
  const result = await executor.query<Row>(
    `INSERT INTO handyman_execution_scopes (
       id, client_id, handyman_request_id, channel_attribution_id,
       quotation_id, approved_quotation_version_id,
       quotation_decision_id, tenant_company_id, tenant_pic_id,
       building_id, floor_id, area_id, room_id, space_id,
       status, created_by_user_id, created_by_actor_type,
       created_by_tenant_pic_id, created_by_pic_session_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'AUTHORIZED',$15,$16,$17,$18
     )
     RETURNING ${SCOPE_COLUMNS}`,
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
      actor.kind === 'USER' ? actor.userId : null,
      actor.kind,
      actor.kind === 'TENANT_PIC' ? actor.tenantPicId : null,
      actor.kind === 'TENANT_PIC' ? actor.picSessionId : null,
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

/** One coherent location snapshot, on the approval's connection (F8/F9). */
async function resolveScopeLocation(
  executor: Pick<PoolClient, 'query'>,
  buildingId: string,
  spaceId: string,
): Promise<Pick<NewHandymanExecutionScope,
  'buildingId' | 'floorId' | 'areaId' | 'roomId' | 'spaceId'> | null> {
  const result = await executor.query<{
    building_id: string; floor_id: string; area_id: string; room_id: string; space_id: string;
  }>(
    `SELECT f.building_id, f.id AS floor_id, a.id AS area_id,
            r.id AS room_id, s.id AS space_id
       FROM spaces s JOIN rooms r ON r.id = s.room_id
       JOIN areas a ON a.id = r.area_id JOIN floors f ON f.id = a.floor_id
      WHERE s.id = $1 AND f.building_id = $2`,
    [spaceId, buildingId],
  );
  const row = result.rows[0];
  return row ? {
    buildingId: row.building_id, floorId: row.floor_id, areaId: row.area_id,
    roomId: row.room_id, spaceId: row.space_id,
  } : null;
}

/** E3 service preflight; the INSERT trigger independently runs this again. */
async function isNewScopeApprovalValid(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanExecutionScope,
): Promise<boolean> {
  const actor = input.actor;
  const result = await executor.query<{ allowed: boolean }>(
    `SELECT handyman_execution_scope_approval_valid(
       jsonb_populate_record(NULL::handyman_execution_scopes, $1::jsonb), true
     ) AS allowed`,
    [{
      client_id: input.clientId,
      handyman_request_id: input.handymanRequestId,
      channel_attribution_id: input.channelAttributionId,
      quotation_id: input.quotationId,
      approved_quotation_version_id: input.approvedQuotationVersionId,
      quotation_decision_id: input.quotationDecisionId,
      tenant_company_id: input.tenantCompanyId,
      tenant_pic_id: input.tenantPicId,
      building_id: input.buildingId,
      floor_id: input.floorId,
      area_id: input.areaId,
      room_id: input.roomId,
      space_id: input.spaceId,
      status: 'AUTHORIZED',
      created_by_actor_type: actor.kind,
      created_by_user_id: actor.kind === 'USER' ? actor.userId : null,
      created_by_tenant_pic_id: actor.kind === 'TENANT_PIC' ? actor.tenantPicId : null,
      created_by_pic_session_id: actor.kind === 'TENANT_PIC' ? actor.picSessionId : null,
    }],
  );
  return result.rows[0]?.allowed === true;
}

/** No scope is created/repaired on replay; an orphan is a cutover blocker. */
async function hasValidScopeApproval(
  executor: Pick<PoolClient, 'query'>,
  scopeId: string,
  decisionId: string,
): Promise<boolean> {
  const result = await executor.query<{ allowed: boolean }>(
    `SELECT handyman_execution_scope_approval_valid(s, false) AS allowed
       FROM handyman_execution_scopes s
      WHERE s.id = $1 AND s.quotation_decision_id = $2`,
    [scopeId, decisionId],
  );
  return result.rows[0]?.allowed === true;
}

export const handymanExecutionScopeRepository = {
  insertScope,
  findScopeByApprovedVersion,
  findScopeById,
  resolveScopeLocation,
  isNewScopeApprovalValid,
  hasValidScopeApproval,
};
