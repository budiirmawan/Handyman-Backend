import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  HandymanBmFeeBeneficiaryKind,
  HandymanBmFeeBeneficiaryRecord,
  HandymanBmFeeRuleBasis,
  HandymanBmFeeRuleMode,
  HandymanBmFeeRuleRecord,
  HandymanBmFeeTermKind,
  HandymanBmFeeTermRecord,
  NewHandymanBmFeeBeneficiary,
  NewHandymanBmFeeRule,
  NewHandymanBmFeeTerm,
} from './handyman-bm-fee-rule.types';

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

/**
 * CR-HM-12 PART 04 — persistence ONLY. A rule stores a governed
 * choice-of-basis fact (basis + role); no numeric fee fact exists
 * or can exist at this layer (§7 boundary: the VALUE is derived by
 * CR-HM-14 from governed transactions plus this bound rule).
 *
 * CR-HM-12 PART 06B extends the same module with the two version-bound
 * prerequisite facts (`handymanBmFeePrerequisiteRepository`): the
 * numeric TERM and the explicit BENEFICIARY. Their authoring follows
 * the identical law — DRAFT window, append-only, exact version — and
 * neither layer computes a fee value.
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

/* ------------------------------------------------------------------
 * CR-HM-12 PART 06B — TERM + BENEFICIARY persistence (FROZEN
 * `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §4.2). SELECT/INSERT
 * ONLY: no UPDATE and no DELETE statement exists in this module —
 * the DRAFT-window and append-only laws are additionally enforced by
 * the 0415 DB triggers. The rate is read as canonical decimal TEXT so
 * no float ever represents it at this layer.
 * ------------------------------------------------------------------ */

const TERM_SELECT = `
  SELECT id, agreement_version_id, term_kind,
         rate_percent::text AS rate_percent, idempotency_key,
         created_by_user_id, created_at
    FROM handyman_bm_fee_term_definitions`;

const BENEFICIARY_SELECT = `
  SELECT id, agreement_version_id, beneficiary_kind,
         beneficiary_reference_id, idempotency_key,
         created_by_user_id, created_at
    FROM handyman_bm_fee_beneficiary_definitions`;

function mapTerm(row: Row): HandymanBmFeeTermRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreement_version_id,
    termKind: row.term_kind as HandymanBmFeeTermKind,
    ratePercent: row.rate_percent,
    idempotencyKey: row.idempotency_key,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

function mapBeneficiary(row: Row): HandymanBmFeeBeneficiaryRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreement_version_id,
    beneficiaryKind: row.beneficiary_kind as HandymanBmFeeBeneficiaryKind,
    beneficiaryReferenceId: row.beneficiary_reference_id,
    idempotencyKey: row.idempotency_key,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function insertTerm(
  executor: Executor,
  record: NewHandymanBmFeeTerm,
): Promise<HandymanBmFeeTermRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_bm_fee_term_definitions (
       id, agreement_version_id, term_kind, rate_percent,
       idempotency_key, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, agreement_version_id, term_kind,
               rate_percent::text AS rate_percent, idempotency_key,
               created_by_user_id, created_at`,
    [
      id,
      record.agreementVersionId,
      record.termKind,
      record.ratePercent,
      record.idempotencyKey,
      record.createdByUserId,
    ],
  );
  return mapTerm(result.rows[0]);
}

async function findTermByVersion(
  executor: Executor,
  agreementVersionId: string,
): Promise<HandymanBmFeeTermRecord | null> {
  const result = await executor.query(
    `${TERM_SELECT} WHERE agreement_version_id = $1`,
    [agreementVersionId],
  );
  return result.rows[0] ? mapTerm(result.rows[0]) : null;
}

async function findTermByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string,
): Promise<HandymanBmFeeTermRecord | null> {
  const result = await executor.query(
    `${TERM_SELECT} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ? mapTerm(result.rows[0]) : null;
}

async function insertBeneficiary(
  executor: Executor,
  record: NewHandymanBmFeeBeneficiary,
): Promise<HandymanBmFeeBeneficiaryRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_bm_fee_beneficiary_definitions (
       id, agreement_version_id, beneficiary_kind,
       beneficiary_reference_id, idempotency_key, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, agreement_version_id, beneficiary_kind,
               beneficiary_reference_id, idempotency_key,
               created_by_user_id, created_at`,
    [
      id,
      record.agreementVersionId,
      record.beneficiaryKind,
      record.beneficiaryReferenceId,
      record.idempotencyKey,
      record.createdByUserId,
    ],
  );
  return mapBeneficiary(result.rows[0]);
}

async function findBeneficiaryByVersion(
  executor: Executor,
  agreementVersionId: string,
): Promise<HandymanBmFeeBeneficiaryRecord | null> {
  const result = await executor.query(
    `${BENEFICIARY_SELECT} WHERE agreement_version_id = $1`,
    [agreementVersionId],
  );
  return result.rows[0] ? mapBeneficiary(result.rows[0]) : null;
}

async function findBeneficiaryByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string,
): Promise<HandymanBmFeeBeneficiaryRecord | null> {
  const result = await executor.query(
    `${BENEFICIARY_SELECT} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ? mapBeneficiary(result.rows[0]) : null;
}

export const handymanBmFeePrerequisiteRepository = {
  insertTerm,
  findTermByVersion,
  findTermByIdempotencyKey,
  insertBeneficiary,
  findBeneficiaryByVersion,
  findBeneficiaryByIdempotencyKey,
};
