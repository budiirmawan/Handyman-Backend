import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  HandymanMaterialPricingBasisRecord,
  HandymanMaterialPricingMode,
  NewHandymanMaterialPricingBasis,
} from './handyman-material-pricing.types';

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

/**
 * CR-HM-12 PART 03 — persistence ONLY. The definition row stores a
 * governed choice-of-basis fact (mode) and nothing else: no money,
 * no quantities (§6 consumption discipline lives in the service).
 */

const BASIS_SELECT = `
  SELECT id, agreement_version_id, mode, idempotency_key,
         created_by_user_id, created_at
    FROM handyman_material_pricing_basis_definitions`;

function mapBasis(row: Row): HandymanMaterialPricingBasisRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreement_version_id,
    mode: row.mode as HandymanMaterialPricingMode,
    idempotencyKey: row.idempotency_key,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function insertBasis(
  executor: Executor,
  record: NewHandymanMaterialPricingBasis,
): Promise<HandymanMaterialPricingBasisRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_material_pricing_basis_definitions (
       id, agreement_version_id, mode, idempotency_key,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, agreement_version_id, mode, idempotency_key,
               created_by_user_id, created_at`,
    [
      id,
      record.agreementVersionId,
      record.mode,
      record.idempotencyKey,
      record.createdByUserId,
    ],
  );
  return mapBasis(result.rows[0]);
}

async function findBasisByVersion(
  executor: Executor,
  agreementVersionId: string,
): Promise<HandymanMaterialPricingBasisRecord | null> {
  const result = await executor.query(
    `${BASIS_SELECT} WHERE agreement_version_id = $1`,
    [agreementVersionId],
  );
  return result.rows[0] ? mapBasis(result.rows[0]) : null;
}

async function findBasisByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string,
): Promise<HandymanMaterialPricingBasisRecord | null> {
  const result = await executor.query(
    `${BASIS_SELECT} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ? mapBasis(result.rows[0]) : null;
}

export const handymanMaterialPricingRepository = {
  insertBasis,
  findBasisByVersion,
  findBasisByIdempotencyKey,
};
