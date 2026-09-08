import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateUtilityTariffInput,
  UtilityTariffFilters,
  UtilityTariffRecord,
} from './utility-tariff.types';

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  utility_type AS "utilityType", currency, uom_id AS "uomId",
  rate_value::text AS "ratePerUom", effective_from AS "effectiveFrom",
  effective_to AS "effectiveUntil", status, created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function resolveBuildingClient(buildingId: string): Promise<string | null> {
  const result = await getPool().query<{ clientId: string }>(
    `SELECT property.client_id AS "clientId"
       FROM buildings building
       JOIN properties property ON property.id = building.property_id
      WHERE building.id = $1`,
    [buildingId],
  );
  return result.rows[0]?.clientId ?? null;
}

async function create(
  clientId: string,
  input: CreateUtilityTariffInput,
): Promise<UtilityTariffRecord> {
  const result = await getPool().query<UtilityTariffRecord>(
    `INSERT INTO utility_calculation_bases
       (id, client_id, building_id, utility_type, name, uom_id, rate_value,
        rate_label, currency, effective_from, effective_to, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${SELECT}`,
    [randomUUID(), clientId, input.buildingId, input.utilityType,
      `${input.utilityType} tariff`, input.uomId, input.ratePerUom,
      'per consumption UOM', input.currency, input.effectiveFrom,
      input.effectiveUntil, input.status],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<UtilityTariffRecord | null> {
  const result = await getPool().query<UtilityTariffRecord>(
    `SELECT ${SELECT} FROM utility_calculation_bases
      WHERE id = $1 AND building_id IS NOT NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function resolveForPeriod(input: {
  clientId: string;
  buildingId: string;
  utilityType: string;
  uomId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<UtilityTariffRecord | null> {
  const result = await getPool().query<UtilityTariffRecord>(
    `SELECT ${SELECT} FROM utility_calculation_bases
      WHERE client_id = $1 AND building_id = $2 AND utility_type = $3
        AND uom_id = $4 AND status = 'ACTIVE'
        AND effective_from <= $5
        AND (effective_to IS NULL OR effective_to >= $6)
      ORDER BY effective_from DESC LIMIT 1`,
    [input.clientId, input.buildingId, input.utilityType, input.uomId,
      input.periodStart, input.periodEnd],
  );
  return result.rows[0] ?? null;
}

async function listByBuilding(
  buildingId: string,
  filters: UtilityTariffFilters,
): Promise<UtilityTariffRecord[]> {
  const values: unknown[] = [buildingId];
  const where = ['building_id = $1'];
  if (filters.utilityType) {
    values.push(filters.utilityType);
    where.push(`utility_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  return (await getPool().query<UtilityTariffRecord>(
    `SELECT ${SELECT} FROM utility_calculation_bases
      WHERE ${where.join(' AND ')}
      ORDER BY utility_type, effective_from DESC`,
    values,
  )).rows;
}

export const utilityTariffRepository = {
  create,
  findById,
  listByBuilding,
  resolveBuildingClient,
  resolveForPeriod,
};
