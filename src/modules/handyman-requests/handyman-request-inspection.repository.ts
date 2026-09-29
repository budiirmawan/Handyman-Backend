import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestInspectionRecord,
  NewHandymanRequestInspectionRecord,
} from './handyman-request-inspection.types';

/**
 * CR-HM-03 PART 02 — Handyman inspection repository (executor-first
 * convention identical to the PART 01 triage repository: shared pool by
 * default; transaction executor as the FIRST argument).
 *
 * Bounded to the FROZEN F2 inspection record ONLY: INSERT (append) and the
 * first-record lookup. No UPDATE/DELETE — the 0381 trigger additionally
 * refuses them for every other actor.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  inspection_result: HandymanRequestInspectionRecord['inspectionResult'];
  inspection_notes: string;
  inspected_by_user_id: string;
  inspected_at: Date;
};

const INSPECTION_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, inspection_result, inspection_notes,
         inspected_by_user_id, inspected_at
    FROM handyman_request_inspections`;

function map(row: Row): HandymanRequestInspectionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    inspectionResult: row.inspection_result,
    inspectionNotes: row.inspection_notes,
    inspectedByUserId: row.inspected_by_user_id,
    inspectedAt: row.inspected_at,
  };
}

async function insertInspection(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanRequestInspectionRecord,
): Promise<HandymanRequestInspectionRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_request_inspections (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, inspection_result, inspection_notes,
       inspected_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, inspection_result, inspection_notes,
               inspected_by_user_id, inspected_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.inspectionResult,
      record.inspectionNotes,
      record.inspectedByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanRequestInspectionRecord | null> {
  const result = await executor.query<Row>(
    `${INSPECTION_SELECT} WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanRequestInspectionRepository = {
  insertInspection,
  findByRequest,
};
