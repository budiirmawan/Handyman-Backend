import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestDiagnosisRecord,
  NewHandymanRequestDiagnosisRecord,
} from './handyman-request-diagnosis.types';

/**
 * CR-HM-03 PART 03 — Handyman diagnosis repository (executor-first; same
 * convention as PART 01/02). Bounded to the FROZEN F2 diagnosis record:
 * INSERT (append) + first-record lookup. No UPDATE/DELETE — the 0382
 * trigger refuses them for every other actor.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  handyman_discipline_id: string;
  discipline_code: string;
  diagnosis: string;
  scope_classification: HandymanRequestDiagnosisRecord['scopeClassification'];
  recommended_service_catalog_id: string | null;
  diagnosed_by_user_id: string;
  diagnosed_at: Date;
};

const DIAGNOSIS_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, handyman_discipline_id, discipline_code, diagnosis,
         scope_classification, recommended_service_catalog_id,
         diagnosed_by_user_id, diagnosed_at
    FROM handyman_request_diagnoses`;

function map(row: Row): HandymanRequestDiagnosisRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    handymanDisciplineId: row.handyman_discipline_id,
    disciplineCode: row.discipline_code,
    diagnosis: row.diagnosis,
    scopeClassification: row.scope_classification,
    recommendedServiceCatalogId: row.recommended_service_catalog_id,
    diagnosedByUserId: row.diagnosed_by_user_id,
    diagnosedAt: row.diagnosed_at,
  };
}

async function insertDiagnosis(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanRequestDiagnosisRecord,
): Promise<HandymanRequestDiagnosisRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_request_diagnoses (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, handyman_discipline_id, discipline_code, diagnosis,
       scope_classification, recommended_service_catalog_id,
       diagnosed_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, handyman_discipline_id, discipline_code,
               diagnosis, scope_classification, recommended_service_catalog_id,
               diagnosed_by_user_id, diagnosed_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.handymanDisciplineId,
      record.disciplineCode,
      record.diagnosis,
      record.scopeClassification,
      record.recommendedServiceCatalogId,
      record.diagnosedByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanRequestDiagnosisRecord | null> {
  const result = await executor.query<Row>(
    `${DIAGNOSIS_SELECT} WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanRequestDiagnosisRepository = {
  insertDiagnosis,
  findByRequest,
};
