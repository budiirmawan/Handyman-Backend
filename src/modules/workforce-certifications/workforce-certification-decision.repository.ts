import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  CertificationDecisionRecord,
  WorkforceCertificationVerificationStatus,
} from './workforce-certification.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B1 — the certification decision ledger
 * (`workforce_certification_decisions`, migration `0464`).
 *
 * Every write is an INSERT. The table rejects UPDATE/DELETE by trigger, so a
 * decision, once recorded, can never be rewritten — the only way to change the
 * current state is to append a new decision.
 */

type Row = QueryResultRow;

const SELECT = `
  SELECT id,
         client_id,
         certification_id,
         workforce_profile_id,
         decision,
         previous_verification_status,
         previous_verified_by_user_id,
         previous_verified_at,
         changed_fields,
         reason,
         decided_by_user_id,
         decided_at
    FROM workforce_certification_decisions`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapRow(row: Row): CertificationDecisionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    certificationId: row.certification_id,
    workforceProfileId: row.workforce_profile_id,
    decision: row.decision as WorkforceCertificationVerificationStatus,
    previousVerificationStatus:
      (row.previous_verification_status as
        | WorkforceCertificationVerificationStatus
        | null) ?? null,
    previousVerifiedByUserId: row.previous_verified_by_user_id ?? null,
    previousVerifiedAt: toNullableIso(row.previous_verified_at),
    changedFields: row.changed_fields ?? null,
    reason: row.reason ?? null,
    decidedByUserId: row.decided_by_user_id ?? null,
    decidedAt: toIso(row.decided_at),
  };
}

export type AppendCertificationDecisionInput = {
  clientId: string;
  certificationId: string;
  workforceProfileId: string;
  decision: WorkforceCertificationVerificationStatus;
  previousVerificationStatus: WorkforceCertificationVerificationStatus | null;
  previousVerifiedByUserId: string | null;
  previousVerifiedAt: Date | string | null;
  changedFields: string[] | null;
  reason: string | null;
  decidedByUserId: string | null;
};

async function appendDecision(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: AppendCertificationDecisionInput,
): Promise<CertificationDecisionRecord> {
  const result = await executor.query(
    `INSERT INTO workforce_certification_decisions (
       id, client_id, certification_id, workforce_profile_id,
       decision, previous_verification_status,
       previous_verified_by_user_id, previous_verified_at,
       changed_fields, reason, decided_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.certificationId,
      input.workforceProfileId,
      input.decision,
      input.previousVerificationStatus,
      input.previousVerifiedByUserId,
      input.previousVerifiedAt,
      input.changedFields,
      input.reason,
      input.decidedByUserId,
    ],
  );
  const created = await findById(executor, result.rows[0].id);
  if (!created) {
    throw new Error(
      'WORKFORCE_CERTIFICATION_DECISION_PERSIST_FAILED: insert returned no row',
    );
  }
  return created;
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<CertificationDecisionRecord | null> {
  const result = await executor.query(`${SELECT} WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function listByCertification(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: {
    certificationId: string;
    clientId: string;
    limit?: number;
    offset?: number;
  },
): Promise<CertificationDecisionRecord[]> {
  const result = await executor.query(
    `${SELECT}
      WHERE certification_id = $1
        AND client_id = $2
      ORDER BY decided_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [
      input.certificationId,
      input.clientId,
      input.limit ?? 100,
      input.offset ?? 0,
    ],
  );
  return result.rows.map(mapRow);
}

async function countByCertification(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: { certificationId: string; clientId: string },
): Promise<number> {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS total
       FROM workforce_certification_decisions
      WHERE certification_id = $1
        AND client_id = $2`,
    [input.certificationId, input.clientId],
  );
  return result.rows[0]?.total ?? 0;
}

export const workforceCertificationDecisionRepository = {
  appendDecision,
  countByCertification,
  findById,
  listByCertification,
};
