import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestTriageDecisionRecord,
  NewHandymanRequestTriageRecord,
} from './handyman-request-triage.types';

/**
 * CR-HM-03 PART 01 — Handyman request triage repository (executor-first
 * convention exactly as the sibling request/evidence repositories: the
 * shared pool is the default connection; a transaction executor comes as
 * argument ONE).
 *
 * Bounded to the FROZEN F2 decision record ONLY: INSERT (append) and
 * first-record lookup. No UPDATE/DELETE — the DB trigger added by 0380
 * additionally refuses them for all other actors.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  triage_disposition: HandymanRequestTriageDecisionRecord['triageDisposition'];
  triage_note: string;
  service_inspection_policy: HandymanRequestTriageDecisionRecord['serviceInspectionPolicy'];
  policy_service_catalog_id: string | null;
  policy_catalog_updated_at: Date | null;
  scope_clarity_confirmed: boolean | null;
  direct_quotation_reason: string | null;
  actor_user_id: string;
  created_at: Date;
};

const TRIAGE_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, triage_disposition, triage_note, actor_user_id,
         service_inspection_policy, policy_service_catalog_id, policy_catalog_updated_at,
         scope_clarity_confirmed, direct_quotation_reason, created_at
    FROM handyman_request_triage_decisions`;

function map(row: Row): HandymanRequestTriageDecisionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    triageDisposition: row.triage_disposition,
    triageNote: row.triage_note,
    serviceInspectionPolicy: row.service_inspection_policy,
    policyServiceCatalogId: row.policy_service_catalog_id,
    policyCatalogUpdatedAt: row.policy_catalog_updated_at,
    scopeClarityConfirmed: row.scope_clarity_confirmed,
    directQuotationReason: row.direct_quotation_reason,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

async function insertDecision(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanRequestTriageRecord,
): Promise<HandymanRequestTriageDecisionRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_request_triage_decisions (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, triage_disposition, triage_note, actor_user_id,
       service_inspection_policy, policy_service_catalog_id, policy_catalog_updated_at,
       scope_clarity_confirmed, direct_quotation_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, triage_disposition, triage_note, actor_user_id,
               service_inspection_policy, policy_service_catalog_id, policy_catalog_updated_at,
               scope_clarity_confirmed, direct_quotation_reason, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.triageDisposition,
      record.triageNote,
      record.actorUserId,
      record.serviceInspectionPolicy, record.policyServiceCatalogId, record.policyCatalogUpdatedAt,
      record.scopeClarityConfirmed, record.directQuotationReason,
    ],
  );
  return map(result.rows[0]);
}

async function findByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanRequestTriageDecisionRecord | null> {
  const result = await executor.query<Row>(
    `${TRIAGE_SELECT} WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanRequestTriageRepository = {
  insertDecision,
  findByRequest,
};
