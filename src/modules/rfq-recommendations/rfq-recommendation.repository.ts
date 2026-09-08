import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  RfqAwardRecord,
  RfqRecommendationRecord,
  RfqRecommendationStatus,
} from './rfq-recommendation.types';

type RecommendationRow = RfqRecommendationRecord;
type AwardRow = RfqAwardRecord;

const RECOMMENDATION_SELECT = `
  id, rfq_id AS "rfqId", client_id AS "clientId", building_id AS "buildingId",
  comparison_run_id AS "comparisonRunId", evidence_id AS "evidenceId",
  quotation_id AS "quotationId", quotation_revision_id AS "quotationRevisionId",
  invitation_id AS "invitationId", vendor_id AS "vendorId", outcome, status,
  reason, notes, created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

const AWARD_SELECT = `
  id, rfq_id AS "rfqId", client_id AS "clientId", building_id AS "buildingId",
  recommendation_id AS "recommendationId", approval_id AS "approvalId",
  comparison_run_id AS "comparisonRunId", evidence_id AS "evidenceId",
  quotation_id AS "quotationId", quotation_revision_id AS "quotationRevisionId",
  invitation_id AS "invitationId", vendor_id AS "vendorId", outcome,
  award_reason AS "awardReason", awarded_by_user_id AS "awardedByUserId",
  awarded_at AS "awardedAt"
`.trim();

export async function findRecommendationById(id: string): Promise<RfqRecommendationRecord | null> {
  const result = await getPool().query<RecommendationRow>(
    `SELECT ${RECOMMENDATION_SELECT} FROM rfq_recommendations WHERE id=$1`, [id],
  );
  return result.rows[0] ?? null;
}

export async function findRecommendationByIdForUpdate(client: PoolClient, id: string): Promise<RfqRecommendationRecord | null> {
  const result = await client.query<RecommendationRow>(
    `SELECT ${RECOMMENDATION_SELECT} FROM rfq_recommendations WHERE id=$1 FOR UPDATE`, [id],
  );
  return result.rows[0] ?? null;
}

export async function findRecommendationByRfq(rfqId: string): Promise<RfqRecommendationRecord | null> {
  const result = await getPool().query<RecommendationRow>(
    `SELECT ${RECOMMENDATION_SELECT} FROM rfq_recommendations WHERE rfq_id=$1`, [rfqId],
  );
  return result.rows[0] ?? null;
}

export async function findRecommendationByRfqForUpdate(client: PoolClient, rfqId: string): Promise<RfqRecommendationRecord | null> {
  const result = await client.query<RecommendationRow>(
    `SELECT ${RECOMMENDATION_SELECT} FROM rfq_recommendations WHERE rfq_id=$1 FOR UPDATE`, [rfqId],
  );
  return result.rows[0] ?? null;
}

export async function createRecommendationWithClient(client: PoolClient, input: {
  rfqId: string;
  clientId: string;
  buildingId: string;
  comparisonRunId: string;
  evidenceId: string | null;
  quotationId: string | null;
  quotationRevisionId: string | null;
  invitationId: string | null;
  vendorId: string | null;
  outcome: 'VENDOR' | 'NO_AWARD';
  reason: string;
  notes: string | null;
  createdByUserId: string;
}): Promise<RfqRecommendationRecord> {
  const result = await client.query<RecommendationRow>(
    `INSERT INTO rfq_recommendations
       (id,rfq_id,client_id,building_id,comparison_run_id,evidence_id,quotation_id,
        quotation_revision_id,invitation_id,vendor_id,outcome,reason,notes,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${RECOMMENDATION_SELECT}`,
    [randomUUID(), input.rfqId, input.clientId, input.buildingId, input.comparisonRunId,
      input.evidenceId, input.quotationId, input.quotationRevisionId, input.invitationId,
      input.vendorId, input.outcome, input.reason, input.notes, input.createdByUserId],
  );
  return result.rows[0];
}

export async function updateRecommendationStatusWithClient(
  client: PoolClient,
  id: string,
  from: RfqRecommendationStatus,
  to: RfqRecommendationStatus,
): Promise<RfqRecommendationRecord | null> {
  const result = await client.query<RecommendationRow>(
    `UPDATE rfq_recommendations
        SET status=$2, updated_at=NOW()
      WHERE id=$1 AND status=$3
      RETURNING ${RECOMMENDATION_SELECT}`,
    [id, to, from],
  );
  return result.rows[0] ?? null;
}

export async function findAwardById(id: string): Promise<RfqAwardRecord | null> {
  const result = await getPool().query<AwardRow>(`SELECT ${AWARD_SELECT} FROM rfq_awards WHERE id=$1`, [id]);
  return result.rows[0] ?? null;
}

export async function findAwardByIdForUpdate(client: PoolClient, id: string): Promise<RfqAwardRecord | null> {
  const result = await client.query<AwardRow>(`SELECT ${AWARD_SELECT} FROM rfq_awards WHERE id=$1 FOR UPDATE`, [id]);
  return result.rows[0] ?? null;
}

export async function findAwardByRfq(rfqId: string): Promise<RfqAwardRecord | null> {
  const result = await getPool().query<AwardRow>(`SELECT ${AWARD_SELECT} FROM rfq_awards WHERE rfq_id=$1`, [rfqId]);
  return result.rows[0] ?? null;
}

export async function findAwardByRfqForUpdate(client: PoolClient, rfqId: string): Promise<RfqAwardRecord | null> {
  const result = await client.query<AwardRow>(`SELECT ${AWARD_SELECT} FROM rfq_awards WHERE rfq_id=$1 FOR UPDATE`, [rfqId]);
  return result.rows[0] ?? null;
}

export async function createAwardWithClient(client: PoolClient, input: {
  rfqId: string;
  clientId: string;
  buildingId: string;
  recommendationId: string;
  approvalId: string;
  comparisonRunId: string;
  evidenceId: string | null;
  quotationId: string | null;
  quotationRevisionId: string | null;
  invitationId: string | null;
  vendorId: string | null;
  outcome: 'VENDOR' | 'NO_AWARD';
  awardReason: string | null;
  awardedByUserId: string;
}): Promise<RfqAwardRecord> {
  const result = await client.query<AwardRow>(
    `INSERT INTO rfq_awards
       (id,rfq_id,client_id,building_id,recommendation_id,approval_id,comparison_run_id,
        evidence_id,quotation_id,quotation_revision_id,invitation_id,vendor_id,outcome,
        award_reason,awarded_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${AWARD_SELECT}`,
    [randomUUID(), input.rfqId, input.clientId, input.buildingId, input.recommendationId,
      input.approvalId, input.comparisonRunId, input.evidenceId, input.quotationId,
      input.quotationRevisionId, input.invitationId, input.vendorId, input.outcome,
      input.awardReason, input.awardedByUserId],
  );
  return result.rows[0];
}

export const rfqRecommendationRepository = {
  createAwardWithClient,
  createRecommendationWithClient,
  findAwardById,
  findAwardByIdForUpdate,
  findAwardByRfq,
  findAwardByRfqForUpdate,
  findRecommendationById,
  findRecommendationByIdForUpdate,
  findRecommendationByRfq,
  findRecommendationByRfqForUpdate,
  updateRecommendationStatusWithClient,
};
