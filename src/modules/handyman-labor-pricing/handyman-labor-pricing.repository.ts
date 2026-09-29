import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  HandymanBillableTimeBasis,
  HandymanCrewPricingMode,
  HandymanLaborPricingBasisRecord,
  HandymanLaborPricingCurrency,
  HandymanLaborPricingMode,
  NewHandymanLaborPricingBasis,
} from './handyman-labor-pricing.types';

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

/**
 * CR-HM-12 PART 02 — persistence ONLY. Shape validation lives in the
 * service (bounded AppErrors) and in DB CHECKs (migration 0407);
 * this layer never re-implements rules. Amounts are returned as
 * exact NUMERIC text via TO_CHAR — no float ever crosses the wire.
 */

const BASIS_SELECT = `
  SELECT id, agreement_version_id, mode, crew_mode,
         billable_time_basis,
         TO_CHAR(unit_amount, 'FM9999999999999990.00') AS unit_amount,
         currency, idempotency_key, created_by_user_id, created_at
    FROM handyman_labor_pricing_basis_definitions`;

function mapBasis(row: Row): HandymanLaborPricingBasisRecord {
  return {
    id: row.id,
    agreementVersionId: row.agreement_version_id,
    mode: row.mode as HandymanLaborPricingMode,
    crewMode: row.crew_mode as HandymanCrewPricingMode,
    billableTimeBasis: row.billable_time_basis as
      HandymanBillableTimeBasis | null,
    unitAmount: String(row.unit_amount),
    currency: row.currency as HandymanLaborPricingCurrency,
    idempotencyKey: row.idempotency_key,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function insertBasis(
  executor: Executor,
  record: NewHandymanLaborPricingBasis,
): Promise<HandymanLaborPricingBasisRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_labor_pricing_basis_definitions (
       id, agreement_version_id, mode, crew_mode, billable_time_basis,
       unit_amount, currency, idempotency_key, created_by_user_id
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::NUMERIC(18,2), $7, $8, $9
     )
     RETURNING id, agreement_version_id, mode, crew_mode,
               billable_time_basis,
               TO_CHAR(unit_amount, 'FM9999999999999990.00')
                 AS unit_amount,
               currency, idempotency_key, created_by_user_id, created_at`,
    [
      id,
      record.agreementVersionId,
      record.mode,
      record.crewMode,
      record.billableTimeBasis,
      record.unitAmount,
      record.currency,
      record.idempotencyKey,
      record.createdByUserId,
    ],
  );
  return mapBasis(result.rows[0]);
}

async function findBasisByMode(
  executor: Executor,
  agreementVersionId: string,
  mode: HandymanLaborPricingMode,
): Promise<HandymanLaborPricingBasisRecord | null> {
  const result = await executor.query(
    `${BASIS_SELECT}
      WHERE agreement_version_id = $1 AND mode = $2`,
    [agreementVersionId, mode],
  );
  return result.rows[0] ? mapBasis(result.rows[0]) : null;
}

async function listBasisByVersion(
  executor: Executor,
  agreementVersionId: string,
): Promise<HandymanLaborPricingBasisRecord[]> {
  const result = await executor.query(
    `${BASIS_SELECT}
      WHERE agreement_version_id = $1
      ORDER BY created_at, id`,
    [agreementVersionId],
  );
  return result.rows.map(mapBasis);
}

async function findBasisByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string,
): Promise<HandymanLaborPricingBasisRecord | null> {
  const result = await executor.query(
    `${BASIS_SELECT} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ? mapBasis(result.rows[0]) : null;
}

async function findBasisById(
  executor: Executor,
  id: string,
): Promise<HandymanLaborPricingBasisRecord | null> {
  const result = await executor.query(
    `${BASIS_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapBasis(result.rows[0]) : null;
}

export const handymanLaborPricingRepository = {
  insertBasis,
  findBasisByMode,
  listBasisByVersion,
  findBasisByIdempotencyKey,
  findBasisById,
};
