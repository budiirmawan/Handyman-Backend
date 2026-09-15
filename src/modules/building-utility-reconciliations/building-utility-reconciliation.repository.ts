import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  BuildingUtilityReconciliationRecord,
  ConsumptionAggregation,
  NewBuildingUtilityReconciliation,
} from './building-utility-reconciliation.types';

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  utility_type AS "utilityType", period_start AS "periodStart",
  period_end AS "periodEnd", uom_id AS "uomId",
  source_consumption_ids AS "sourceConsumptionIds",
  tenant_consumption_ids AS "tenantConsumptionIds",
  common_area_consumption_ids AS "commonAreaConsumptionIds",
  source_consumption::text AS "sourceConsumption",
  tenant_consumption::text AS "tenantConsumption",
  common_area_consumption::text AS "commonAreaConsumption",
  unallocated_consumption::text AS "unallocatedConsumption",
  reconciliation_percentage::text AS "reconciliationPercentage",
  applicable_area_sqm::text AS "applicableAreaSqm",
  performance_metric AS "performanceMetric",
  performance_value::text AS "performanceValue",
  calculated_at AS "calculatedAt",
  calculated_by_user_id AS "calculatedByUserId", created_at AS "createdAt"`;

async function resolveBuildingClient(buildingId: string): Promise<string | null> {
  const result = await getPool().query<{ clientId: string }>(
    `SELECT property.client_id AS "clientId" FROM buildings building
     JOIN properties property ON property.id = building.property_id
     WHERE building.id = $1`, [buildingId],
  );
  return result.rows[0]?.clientId ?? null;
}

/**
 * Uses only consumption whose two source readings are ACTUAL and whose exact
 * period equals the governed reconciliation period. This is the strongest
 * verification fact in the current reading contract; ESTIMATED readings are
 * deliberately excluded.
 */
async function aggregateConsumptions(input: {
  clientId: string;
  buildingId: string;
  utilityType: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<ConsumptionAggregation> {
  const result = await getPool().query<Omit<ConsumptionAggregation, 'clientId'>>(
    `SELECT
       COALESCE(ARRAY_AGG(consumption.id ORDER BY consumption.id)
         FILTER (WHERE meter.purpose IN ('BUILDING','ENERGY_SOURCE')), '{}') AS "sourceConsumptionIds",
       COALESCE(ARRAY_AGG(consumption.id ORDER BY consumption.id)
         FILTER (WHERE meter.purpose = 'TENANT'), '{}') AS "tenantConsumptionIds",
       COALESCE(ARRAY_AGG(consumption.id ORDER BY consumption.id)
         FILTER (WHERE meter.purpose = 'COMMON_AREA'), '{}') AS "commonAreaConsumptionIds",
       COALESCE(ARRAY_AGG(DISTINCT consumption.uom_id), '{}') AS "uomIds",
       COALESCE(SUM(consumption.consumption_value)
         FILTER (WHERE meter.purpose IN ('BUILDING','ENERGY_SOURCE')), 0)::text AS "sourceConsumption",
       COALESCE(SUM(consumption.consumption_value)
         FILTER (WHERE meter.purpose = 'TENANT'), 0)::text AS "tenantConsumption",
       COALESCE(SUM(consumption.consumption_value)
         FILTER (WHERE meter.purpose = 'COMMON_AREA'), 0)::text AS "commonAreaConsumption"
     FROM utility_meter_consumptions consumption
     JOIN utility_meters meter ON meter.id = consumption.meter_id
     JOIN utility_meter_readings previous
       ON previous.id = consumption.previous_reading_id
     JOIN utility_meter_readings current
       ON current.id = consumption.current_reading_id
     WHERE consumption.client_id = $1 AND consumption.building_id = $2
       AND meter.client_id = $1 AND meter.building_id = $2
       AND meter.utility_type = $3
       AND consumption.period_start = $4 AND consumption.period_end = $5
       AND previous.reading_type = 'ACTUAL' AND current.reading_type = 'ACTUAL'`,
    [input.clientId, input.buildingId, input.utilityType,
      input.periodStart, input.periodEnd],
  );
  return { clientId: input.clientId, ...result.rows[0] };
}

async function sumApplicableArea(buildingId: string): Promise<string | null> {
  const result = await getPool().query<{ areaSqm: string | null }>(
    `SELECT SUM(space.area_sqm)::text AS "areaSqm"
     FROM spaces space
     JOIN rooms room ON room.id = space.room_id
     JOIN areas area ON area.id = room.area_id
     JOIN floors floor ON floor.id = area.floor_id
     WHERE floor.building_id = $1 AND space.status = 'ACTIVE'
       AND space.area_sqm IS NOT NULL`, [buildingId],
  );
  return result.rows[0]?.areaSqm ?? null;
}

async function create(input: NewBuildingUtilityReconciliation): Promise<BuildingUtilityReconciliationRecord> {
  const result = await getPool().query<BuildingUtilityReconciliationRecord>(
    `INSERT INTO building_utility_reconciliations
      (id, client_id, building_id, utility_type, period_start, period_end,
       uom_id, source_consumption_ids, tenant_consumption_ids,
       common_area_consumption_ids, source_consumption, tenant_consumption,
       common_area_consumption, unallocated_consumption,
       reconciliation_percentage, applicable_area_sqm, performance_metric,
       performance_value, calculated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12::numeric,
       $13::numeric, $11::numeric-$12::numeric-$13::numeric,
       CASE WHEN $11::numeric=0 THEN NULL
         ELSE (($12::numeric+$13::numeric)/$11::numeric)*100 END,
       $14::numeric,$15,$11::numeric/$14::numeric,$16)
     RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.buildingId, input.utilityType,
      input.periodStart, input.periodEnd, input.uomId,
      input.sourceConsumptionIds, input.tenantConsumptionIds,
      input.commonAreaConsumptionIds, input.sourceConsumption,
      input.tenantConsumption, input.commonAreaConsumption,
      input.applicableAreaSqm, input.performanceMetric,
      input.calculatedByUserId],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<BuildingUtilityReconciliationRecord | null> {
  const result = await getPool().query<BuildingUtilityReconciliationRecord>(
    `SELECT ${SELECT} FROM building_utility_reconciliations WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}
async function findByScope(input: {
  buildingId: string; utilityType: string; periodStart: Date; periodEnd: Date;
}): Promise<BuildingUtilityReconciliationRecord | null> {
  const result = await getPool().query<BuildingUtilityReconciliationRecord>(
    `SELECT ${SELECT} FROM building_utility_reconciliations
     WHERE building_id=$1 AND utility_type=$2 AND period_start=$3 AND period_end=$4`,
    [input.buildingId, input.utilityType, input.periodStart, input.periodEnd],
  );
  return result.rows[0] ?? null;
}
async function listByBuilding(buildingId: string): Promise<BuildingUtilityReconciliationRecord[]> {
  return (await getPool().query<BuildingUtilityReconciliationRecord>(
    `SELECT ${SELECT} FROM building_utility_reconciliations
     WHERE building_id=$1 ORDER BY period_end DESC, utility_type`, [buildingId],
  )).rows;
}

export const buildingUtilityReconciliationRepository = {
  aggregateConsumptions, create, findById, findByScope, listByBuilding,
  resolveBuildingClient, sumApplicableArea,
};
