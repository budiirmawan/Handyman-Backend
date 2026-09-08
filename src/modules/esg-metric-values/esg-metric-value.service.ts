import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { getPool } from '../../database';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleBuildingIds,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  esgMetricValueBuildingInactiveError,
  esgMetricValueBuildingNotFoundError,
  esgMetricValueDefinitionClientMismatchError,
  esgMetricValueDefinitionInactiveError,
  esgMetricValueDefinitionNotFoundError,
  esgMetricValueMissingValueInvalidError,
  esgMetricValueNotFoundError,
  esgMetricValuePeriodExistsError,
  esgMetricValuePeriodInvalidError,
  esgMetricValueUomClientMismatchError,
  esgMetricValueUomInactiveError,
  esgMetricValueUomNotFoundError,
} from './esg-metric-value.errors';
import { esgMetricValueRepository } from './esg-metric-value.repository';
import type {
  CreateEsgMetricValueInput,
  EsgMetricValueFilters,
  EsgMetricValueRecord,
  NewEsgMetricValue,
  PublicEsgMetricValue,
  UpdateEsgMetricValueInput,
} from './esg-metric-value.types';

type BuildingRow = { id: string; property_id: string; status: string };
type PropertyRow = { id: string; client_id: string };
type UomRow = { id: string; client_id: string; status: string };
type MetricDefRow = {
  id: string;
  client_id: string;
  code: string;
  status: string;
};

function toPublic(rec: EsgMetricValueRecord): PublicEsgMetricValue {
  let sourceRefs: string[] | null = null;
  if (rec.sourceRefs) {
    try {
      const parsed = typeof rec.sourceRefs === 'string' ? JSON.parse(rec.sourceRefs as string) : rec.sourceRefs;
      if (Array.isArray(parsed)) sourceRefs = parsed as string[];
    } catch {
      sourceRefs = null;
    }
  }

  return {
    id: rec.id,
    clientId: rec.clientId,
    buildingId: rec.buildingId,
    metricDefinitionId: rec.metricDefinitionId,
    periodType: rec.periodType,
    periodStart: rec.periodStart instanceof Date ? rec.periodStart.toISOString() : String(rec.periodStart),
    periodEnd: rec.periodEnd instanceof Date ? rec.periodEnd.toISOString() : String(rec.periodEnd),
    value: rec.value === null || rec.value === undefined ? null : Number(rec.value),
    uomId: rec.uomId,
    calculationMethod: rec.calculationMethod,
    sourceType: rec.sourceType,
    sourceRefs,
    dataQuality: rec.dataQuality,
    verificationStatus: rec.verificationStatus,
    createdByUserId: rec.createdByUserId,
    createdAt: rec.createdAt instanceof Date ? rec.createdAt.toISOString() : String(rec.createdAt),
    updatedAt: rec.updatedAt instanceof Date ? rec.updatedAt.toISOString() : String(rec.updatedAt),
  };
}

function metadata(rec: EsgMetricValueRecord): Record<string, unknown> {
  return {
    buildingId: rec.buildingId,
    metricDefinitionId: rec.metricDefinitionId,
    periodType: rec.periodType,
    periodStart: rec.periodStart,
    periodEnd: rec.periodEnd,
    value: rec.value,
    uomId: rec.uomId,
    calculationMethod: rec.calculationMethod,
    sourceType: rec.sourceType,
    dataQuality: rec.dataQuality,
    verificationStatus: rec.verificationStatus,
    clientId: rec.clientId,
  };
}

async function resolveBuildingClient(
  buildingId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<{ buildingId: string; clientId: string }> {
  const bRes = await executor.query<BuildingRow>(
    `SELECT id, property_id, status FROM buildings WHERE id = $1`,
    [buildingId],
  );
  const building = bRes.rows[0];
  if (!building) throw esgMetricValueBuildingNotFoundError();
  if (building.status !== 'ACTIVE') throw esgMetricValueBuildingInactiveError();

  const pRes = await executor.query<PropertyRow>(
    `SELECT id, client_id FROM properties WHERE id = $1`,
    [building.property_id],
  );
  const prop = pRes.rows[0];
  if (!prop) throw esgMetricValueBuildingNotFoundError();

  return { buildingId: building.id, clientId: prop.client_id };
}

async function validateMetricDefinition(
  metricDefinitionId: string,
  clientId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<MetricDefRow> {
  const res = await executor.query<MetricDefRow>(
    `SELECT id, client_id, code, status FROM esg_metric_definitions WHERE id = $1`,
    [metricDefinitionId],
  );
  const row = res.rows[0];
  if (!row) throw esgMetricValueDefinitionNotFoundError();
  if (row.client_id !== clientId) throw esgMetricValueDefinitionClientMismatchError();
  if (row.status !== 'ACTIVE') throw esgMetricValueDefinitionInactiveError();
  return row;
}

async function validateUom(
  uomId: string,
  clientId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<UomRow> {
  const res = await executor.query<UomRow>(
    `SELECT id, client_id, status FROM units_of_measure WHERE id = $1`,
    [uomId],
  );
  const row = res.rows[0];
  if (!row) throw esgMetricValueUomNotFoundError();
  if (row.client_id !== clientId) throw esgMetricValueUomClientMismatchError();
  if (row.status !== 'ACTIVE') throw esgMetricValueUomInactiveError();
  return row;
}

function validateValueQuality(value: number | null | undefined, dataQuality: string): void {
  if (dataQuality === 'MISSING') {
    // value may be null or absent; if present it must be null? Allow null only to avoid fabricating
    if (value !== undefined && value !== null) {
      throw esgMetricValueMissingValueInvalidError();
    }
  } else {
    if (value === undefined || value === null) {
      throw esgMetricValueMissingValueInvalidError();
    }
  }
}

export async function createEsgMetricValue(
  input: CreateEsgMetricValueInput,
  actorUserId: string,
): Promise<PublicEsgMetricValue> {
  const { clientId, buildingId } = await resolveBuildingClient(input.buildingId);

  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }

  await validateMetricDefinition(input.metricDefinitionId, clientId);
  await validateUom(input.uomId, clientId);

  const periodStart = new Date(input.periodStart);
  const periodEnd = new Date(input.periodEnd);
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodEnd <= periodStart) {
    throw esgMetricValuePeriodInvalidError();
  }

  const dataQuality = input.dataQuality ?? 'ACTUAL';
  const value = input.value ?? null;
  validateValueQuality(value as number | null | undefined, dataQuality);

  const newRec: NewEsgMetricValue = {
    clientId,
    buildingId,
    metricDefinitionId: input.metricDefinitionId,
    periodType: input.periodType,
    periodStart,
    periodEnd,
    value: value as number | null,
    uomId: input.uomId,
    calculationMethod: input.calculationMethod,
    sourceType: input.sourceType,
    sourceRefs: input.sourceRefs ?? null,
    dataQuality,
    verificationStatus: input.verificationStatus ?? 'PENDING',
    createdByUserId: actorUserId,
  };

  try {
    return await withTransaction(async (tx) => {
      const rec = await esgMetricValueRepository.insert(tx, newRec);

      await recordOperationalEvent(
        {
          clientId: rec.clientId,
          buildingId: rec.buildingId,
          eventType: 'ESG_METRIC_VALUE_CREATED',
          entityType: 'ESG_METRIC_VALUE',
          entityId: rec.id,
          actorUserId,
          summary: `ESG metric value ${rec.metricDefinitionId} ${rec.periodType} ${rec.periodStart.toISOString()}–${rec.periodEnd.toISOString()} created.`,
          metadata: metadata(rec),
        },
        tx,
      );

      return toPublic(rec);
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null) {
      const candidate = error as { code?: string; constraint?: string };
      if (candidate.code === '23505' && candidate.constraint === 'esg_metric_values_unique_period') {
        throw esgMetricValuePeriodExistsError();
      }
    }
    throw error;
  }
}

export async function getEsgMetricValue(
  id: string,
  actorUserId: string,
): Promise<PublicEsgMetricValue> {
  const rec = await esgMetricValueRepository.findById(undefined, id);
  if (!rec) throw esgMetricValueNotFoundError();

  if (!(await contextAccessService.canAccessBuilding(actorUserId, rec.buildingId))) {
    throw buildingAccessDeniedError();
  }

  return toPublic(rec);
}

export async function listEsgMetricValues(
  filters: EsgMetricValueFilters,
  actorUserId: string,
): Promise<PublicEsgMetricValue[]> {
  const accessibleBuildingIds = await getAccessibleBuildingIds(actorUserId);

  if (filters.buildingId && !accessibleBuildingIds.includes(filters.buildingId)) {
    return [];
  }

  if (filters.clientId) {
    if (!(await contextAccessService.canAccessClient(actorUserId, filters.clientId))) {
      return [];
    }
  }

  const recs = await esgMetricValueRepository.listScoped(
    undefined,
    accessibleBuildingIds,
    filters,
  );
  return recs.map(toPublic);
}

export async function updateEsgMetricValue(
  id: string,
  input: UpdateEsgMetricValueInput,
  actorUserId: string,
): Promise<PublicEsgMetricValue> {
  const existing = await esgMetricValueRepository.findById(undefined, id);
  if (!existing) throw esgMetricValueNotFoundError();

  if (!(await contextAccessService.canAccessBuilding(actorUserId, existing.buildingId))) {
    throw buildingAccessDeniedError();
  }

  if (input.uomId !== undefined) {
    await validateUom(input.uomId, existing.clientId);
  }

  // Validate value/quality coherence if either changes
  if (input.dataQuality !== undefined || input.value !== undefined) {
    const effectiveQuality = input.dataQuality ?? existing.dataQuality;
    const effectiveValue =
      input.value !== undefined ? input.value : existing.value === null ? null : Number(existing.value);
    validateValueQuality(effectiveValue as number | null | undefined, effectiveQuality);
  }

  return withTransaction(async (tx) => {
    const updated = await esgMetricValueRepository.update(tx, id, {
      value: input.value,
      uomId: input.uomId,
      calculationMethod: input.calculationMethod,
      sourceType: input.sourceType,
      sourceRefs: input.sourceRefs,
      dataQuality: input.dataQuality,
      verificationStatus: input.verificationStatus,
    });

    if (!updated) throw esgMetricValueNotFoundError();

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'ESG_METRIC_VALUE_UPDATED',
        entityType: 'ESG_METRIC_VALUE',
        entityId: updated.id,
        actorUserId,
        summary: `ESG metric value ${updated.id} updated.`,
        metadata: metadata(updated),
      },
      tx,
    );

    return toPublic(updated);
  });
}

export const esgMetricValueService = {
  createEsgMetricValue,
  getEsgMetricValue,
  listEsgMetricValues,
  updateEsgMetricValue,
};
