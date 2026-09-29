import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  HandymanBmFeeRuleBasis,
  HandymanBmFeeRuleMode,
  HandymanBmFeeRuleRecord,
  NewHandymanBmFeeRule,
} from './handyman-bm-fee-rule.types';

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

/**
 * CR-HM-12 PART 04 — persistence ONLY. A rule stores a governed
 * choice-of-basis fact (basis + role); no numeric fee fact exists
 * or can exist at this layer (§7 boundary: the VALUE is derived by
 * CR-HM-14 from governed transactions plus this bound rule).
 */

const RULE_SELECT = `
  SELECT id, agreement_version_id, basis, mode, idempotency_key,
         created_by_user_id, created_at
    FROM handyman_bm_fee_rule_definitions`;

function mapRule(row: Row): HandymanBmFeeRuleRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreement_version_id,
    basis: row.basis as HandymanBmFeeRuleBasis,
    mode: row.mode as HandymanBmFeeRuleMode,
    idempotencyKey: row.idempotency_key,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function insertRule(
  executor: Executor,
  record: NewHandymanBmFeeRule,
): Promise<HandymanBmFeeRuleRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_bm_fee_rule_definitions (
       id, agreement_version_id, basis, mode, idempotency_key,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, agreement_version_id, basis, mode,
               idempotency_key, created_by_user_id, created_at`,
    [
      id,
      record.agreementVersionId,
      record.basis,
      record.mode,
      record.idempotencyKey,
      record.createdByUserId,
    ],
  );
  return mapRule(result.rows[0]);
}

async function findRuleByVersion(
  executor: Executor,
  agreementVersionId: string,
): Promise<HandymanBmFeeRuleRecord | null> {
  const result = await executor.query(
    `${RULE_SELECT} WHERE agreement_version_id = $1`,
    [agreementVersionId],
  );
  return result.rows[0] ? mapRule(result.rows[0]) : null;
}

async function findRuleByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string,
): Promise<HandymanBmFeeRuleRecord | null> {
  const result = await executor.query(
    `${RULE_SELECT} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ? mapRule(result.rows[0]) : null;
}

export const handymanBmFeeRuleRepository = {
  insertRule,
  findRuleByVersion,
  findRuleByIdempotencyKey,
};
