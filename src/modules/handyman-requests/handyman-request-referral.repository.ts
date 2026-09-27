import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestReferralRecord,
  NewHandymanRequestReferralRecord,
} from './handyman-request-referral.types';

/**
 * CR-HM-03 PART 04 — Handyman referral repository (executor-first; same
 * convention as PART 01–03). Bounded to the FROZEN F2 referral record:
 * INSERT (append) + first-record lookup. No UPDATE/DELETE — the 0383
 * trigger refuses them for every other actor.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  handyman_diagnosis_id: string;
  referral_type: HandymanRequestReferralRecord['referralType'];
  handyman_discipline_id: string;
  discipline_code: string;
  referral_note: string;
  referred_by_user_id: string;
  referred_at: Date;
};

const REFERRAL_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, handyman_diagnosis_id, referral_type,
         handyman_discipline_id, discipline_code, referral_note,
         referred_by_user_id, referred_at
    FROM handyman_request_referrals`;

function map(row: Row): HandymanRequestReferralRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    handymanDiagnosisId: row.handyman_diagnosis_id,
    referralType: row.referral_type,
    handymanDisciplineId: row.handyman_discipline_id,
    disciplineCode: row.discipline_code,
    referralNote: row.referral_note,
    referredByUserId: row.referred_by_user_id,
    referredAt: row.referred_at,
  };
}

async function insertReferral(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanRequestReferralRecord,
): Promise<HandymanRequestReferralRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_request_referrals (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, handyman_diagnosis_id, referral_type,
       handyman_discipline_id, discipline_code, referral_note,
       referred_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, handyman_diagnosis_id, referral_type,
               handyman_discipline_id, discipline_code, referral_note,
               referred_by_user_id, referred_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.handymanDiagnosisId,
      record.referralType,
      record.handymanDisciplineId,
      record.disciplineCode,
      record.referralNote,
      record.referredByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanRequestReferralRecord | null> {
  const result = await executor.query<Row>(
    `${REFERRAL_SELECT} WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanRequestReferralRepository = {
  insertReferral,
  findByRequest,
};
