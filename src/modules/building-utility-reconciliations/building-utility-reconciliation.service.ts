import { buildingNotFoundError } from '../buildings';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  buildingUtilityReconciliationAreaMissingError,
  buildingUtilityReconciliationDuplicateError,
  buildingUtilityReconciliationNoSourceError,
  buildingUtilityReconciliationNotFoundError,
  buildingUtilityReconciliationUomMismatchError,
} from './building-utility-reconciliation.errors';
import { buildingUtilityReconciliationRepository as repository } from './building-utility-reconciliation.repository';
import type {
  BuildingUtilityReconciliationRecord,
  CreateBuildingUtilityReconciliationInput,
  PublicBuildingUtilityReconciliation,
} from './building-utility-reconciliation.types';

const toPublic = (record: BuildingUtilityReconciliationRecord): PublicBuildingUtilityReconciliation => ({
  ...record,
  periodStart: record.periodStart.toISOString(),
  periodEnd: record.periodEnd.toISOString(),
  sourceConsumption: Number(record.sourceConsumption),
  tenantConsumption: Number(record.tenantConsumption),
  commonAreaConsumption: Number(record.commonAreaConsumption),
  unallocatedConsumption: Number(record.unallocatedConsumption),
  reconciliationPercentage: record.reconciliationPercentage === null
    ? null : Number(record.reconciliationPercentage),
  applicableAreaSqm: Number(record.applicableAreaSqm),
  performanceValue: Number(record.performanceValue),
  performanceUom: record.performanceMetric === 'IKE' ? 'kWh/m²' : 'm³/m²',
  calculatedAt: record.calculatedAt.toISOString(),
  createdAt: record.createdAt.toISOString(),
});

export async function createBuildingUtilityReconciliation(
  input: CreateBuildingUtilityReconciliationInput,
  actorUserId: string,
): Promise<PublicBuildingUtilityReconciliation> {
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);
  const clientId = await repository.resolveBuildingClient(input.buildingId);
  if (!clientId) throw buildingNotFoundError();
  if (await repository.findByScope(input)) throw buildingUtilityReconciliationDuplicateError();

  const aggregation = await repository.aggregateConsumptions({ clientId, ...input });
  if (aggregation.sourceConsumptionIds.length === 0) {
    throw buildingUtilityReconciliationNoSourceError();
  }
  if (aggregation.uomIds.length !== 1) {
    throw buildingUtilityReconciliationUomMismatchError();
  }
  const applicableAreaSqm = await repository.sumApplicableArea(input.buildingId);
  if (!applicableAreaSqm || Number(applicableAreaSqm) <= 0) {
    throw buildingUtilityReconciliationAreaMissingError();
  }

  try {
    const record = await repository.create({
      ...aggregation,
      buildingId: input.buildingId,
      utilityType: input.utilityType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      uomId: aggregation.uomIds[0],
      applicableAreaSqm,
      performanceMetric: input.utilityType === 'ELECTRICITY' ? 'IKE' : 'IKA',
      calculatedByUserId: actorUserId,
    });
    await recordOperationalEvent({
      clientId, buildingId: input.buildingId,
      eventType: 'BUILDING_UTILITY_RECONCILIATION_CALCULATED',
      entityType: 'BUILDING_UTILITY_RECONCILIATION', entityId: record.id,
      actorUserId,
      summary: `${record.performanceMetric} and ${record.utilityType} reconciliation calculated`,
      metadata: {
        utilityType: record.utilityType,
        periodStart: record.periodStart.toISOString(),
        periodEnd: record.periodEnd.toISOString(),
        sourceConsumption: record.sourceConsumption,
        tenantConsumption: record.tenantConsumption,
        commonAreaConsumption: record.commonAreaConsumption,
        unallocatedConsumption: record.unallocatedConsumption,
        applicableAreaSqm: record.applicableAreaSqm,
        performanceValue: record.performanceValue,
      },
    });
    return toPublic(record);
  } catch (error) {
    const candidate = error as { code?: string; constraint?: string };
    if (candidate.code === '23505' && candidate.constraint === 'building_utility_reconciliation_scope_unique') {
      throw buildingUtilityReconciliationDuplicateError();
    }
    throw error;
  }
}

export async function getBuildingUtilityReconciliation(
  id: string,
  actorUserId: string,
): Promise<PublicBuildingUtilityReconciliation> {
  const record = await repository.findById(id);
  if (!record) throw buildingUtilityReconciliationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}
export async function listBuildingUtilityReconciliations(
  buildingId: string,
  actorUserId: string,
): Promise<PublicBuildingUtilityReconciliation[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  if (!(await repository.resolveBuildingClient(buildingId))) throw buildingNotFoundError();
  return (await repository.listByBuilding(buildingId)).map(toPublic);
}

export const buildingUtilityReconciliationService = {
  createBuildingUtilityReconciliation,
  getBuildingUtilityReconciliation,
  listBuildingUtilityReconciliations,
};
