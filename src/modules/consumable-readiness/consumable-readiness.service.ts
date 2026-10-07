import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  cleaningAreaBuildingMismatchError,
  cleaningAreaInactiveError,
  cleaningAreaNotFoundError,
  cleaningAreaRepository,
} from '../cleaning-areas';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  consumableRequirementCodeAlreadyExistsError,
  consumableRequirementInactiveError,
  consumableRequirementNotFoundError,
} from './consumable-readiness.errors';
import {
  consumableReadinessRepository,
  type ReadinessWithRequirementRow,
  type RequirementWithContextRow,
} from './consumable-readiness.repository';
import type {
  ConsumableReadinessFilter,
  ConsumableRequirementFilter,
  ConsumableRequirementRecord,
  CreateConsumableRequirementInput,
  PublicConsumableReadiness,
  PublicConsumableRequirement,
  RecordConsumableReadinessInput,
  UpdateConsumableRequirementInput,
} from './consumable-readiness.types';

export function toPublicRequirement(
  row: RequirementWithContextRow | ConsumableRequirementRecord,
): PublicConsumableRequirement {
  const isContextRow = 'client_id' in row;
  const ctx = isContextRow ? (row as RequirementWithContextRow) : null;
  const rec = !isContextRow ? (row as ConsumableRequirementRecord) : null;

  const clientId = rec ? rec.clientId : ctx!.client_id;
  const buildingId = rec ? rec.buildingId : ctx!.building_id;
  const cleaningAreaId = rec ? rec.cleaningAreaId : ctx!.cleaning_area_id;
  const requiredQuantity = rec ? rec.requiredQuantity : Number(ctx!.required_quantity);
  const createdAt = rec ? rec.createdAt : ctx!.created_at;
  const updatedAt = rec ? rec.updatedAt : ctx!.updated_at;

  return {
    id: row.id,
    clientId,
    buildingId,
    cleaningAreaId,
    code: row.code,
    name: row.name,
    requiredQuantity,
    unit: row.unit,
    status: row.status,
    createdAt:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : String(createdAt),
    updatedAt:
      updatedAt instanceof Date
        ? updatedAt.toISOString()
        : String(updatedAt),
    cleaningArea:
      ctx && ctx.area_code
        ? {
            id: ctx.cleaning_area_id!,
            code: ctx.area_code,
            name: ctx.area_name!,
            status: ctx.area_status!,
          }
        : null,
    currentReadiness:
      ctx && ctx.latest_readiness_status
        ? {
            readinessStatus: ctx.latest_readiness_status,
            availableQuantity:
              ctx.latest_available_quantity === null
                ? null
                : Number(ctx.latest_available_quantity),
            checkedAt:
              ctx.latest_checked_at instanceof Date
                ? ctx.latest_checked_at.toISOString()
                : String(ctx.latest_checked_at),
          }
        : null,
  };
}

export function toPublicReadiness(
  row: ReadinessWithRequirementRow,
): PublicConsumableReadiness {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    requirementId: row.requirement_id,
    operationalDate:
      row.operational_date instanceof Date
        ? row.operational_date.toISOString().slice(0, 10)
        : String(row.operational_date),
    readinessStatus: row.readiness_status,
    availableQuantity:
      row.available_quantity === null ? null : Number(row.available_quantity),
    checkedByUserId: row.checked_by_user_id,
    checkedAt:
      row.checked_at instanceof Date
        ? row.checked_at.toISOString()
        : String(row.checked_at),
    notes: row.notes,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    requirement: {
      id: row.requirement_id,
      code: row.requirement_code,
      name: row.requirement_name,
      requiredQuantity: Number(row.requirement_quantity),
      unit: row.requirement_unit,
    },
    cleaningArea: row.area_id
      ? {
          id: row.area_id,
          code: row.area_code!,
          name: row.area_name!,
        }
      : null,
  };
}

export async function createConsumableRequirement(
  input: CreateConsumableRequirementInput,
): Promise<PublicConsumableRequirement> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }

  if (input.cleaningAreaId) {
    const area = await cleaningAreaRepository.findById(input.cleaningAreaId);
    if (!area) {
      throw cleaningAreaNotFoundError();
    }
    if (area.buildingId !== input.buildingId) {
      throw cleaningAreaBuildingMismatchError();
    }
    if (area.status !== 'ACTIVE') {
      throw cleaningAreaInactiveError();
    }
  }

  const existing = await consumableReadinessRepository.findRequirementByCode(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw consumableRequirementCodeAlreadyExistsError();
  }

  const record = await consumableReadinessRepository.createRequirement({
    ...input,
    clientId: property.clientId,
  });

  const full = await consumableReadinessRepository.findRequirementById(
    record.id,
  );
  return toPublicRequirement(full!);
}

export async function getConsumableRequirementById(
  id: string,
): Promise<PublicConsumableRequirement> {
  const row = await consumableReadinessRepository.findRequirementById(id);
  if (!row) {
    throw consumableRequirementNotFoundError();
  }
  return toPublicRequirement(row);
}

export async function listConsumableRequirements(
  filter: ConsumableRequirementFilter = {},
): Promise<PublicConsumableRequirement[]> {
  if (filter.buildingId) {
    const building = await buildingRepository.findById(filter.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
  }

  if (filter.cleaningAreaId) {
    const area = await cleaningAreaRepository.findById(filter.cleaningAreaId);
    if (!area) {
      throw cleaningAreaNotFoundError();
    }
  }

  const rows = await consumableReadinessRepository.listRequirements(filter);
  return rows.map(toPublicRequirement);
}

export async function updateConsumableRequirement(
  id: string,
  input: UpdateConsumableRequirementInput,
): Promise<PublicConsumableRequirement> {
  const existing = await consumableReadinessRepository.findRequirementById(id);
  if (!existing) {
    throw consumableRequirementNotFoundError();
  }

  if (input.cleaningAreaId) {
    const area = await cleaningAreaRepository.findById(input.cleaningAreaId);
    if (!area) {
      throw cleaningAreaNotFoundError();
    }
    if (area.buildingId !== existing.building_id) {
      throw cleaningAreaBuildingMismatchError();
    }
  }

  await consumableReadinessRepository.updateRequirement(id, input);

  const full = await consumableReadinessRepository.findRequirementById(id);
  return toPublicRequirement(full!);
}

export async function recordConsumableReadiness(
  input: RecordConsumableReadinessInput,
): Promise<PublicConsumableReadiness> {
  const requirement =
    await consumableReadinessRepository.findRequirementById(
      input.requirementId,
    );
  if (!requirement) {
    throw consumableRequirementNotFoundError();
  }
  if (requirement.status !== 'ACTIVE') {
    throw consumableRequirementInactiveError();
  }

  const operationalDate =
    input.operationalDate ?? new Date().toISOString().slice(0, 10);

  const check = await consumableReadinessRepository.recordReadiness({
    clientId: requirement.client_id,
    buildingId: requirement.building_id,
    requirementId: requirement.id,
    operationalDate,
    readinessStatus: input.readinessStatus,
    availableQuantity: input.availableQuantity ?? null,
    checkedByUserId: input.checkedByUserId,
    notes: input.notes ?? null,
  });

  const list = await consumableReadinessRepository.listReadiness({
    buildingId: requirement.building_id,
  });
  const row = list.find((r) => r.id === check.id);
  return toPublicReadiness(row ?? (check as any));
}

export async function listConsumableReadiness(
  filter: ConsumableReadinessFilter = {},
): Promise<PublicConsumableReadiness[]> {
  if (filter.buildingId) {
    const building = await buildingRepository.findById(filter.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
  }

  const rows = await consumableReadinessRepository.listReadiness(filter);
  return rows.map(toPublicReadiness);
}

export const consumableReadinessService = {
  createConsumableRequirement,
  getConsumableRequirementById,
  listConsumableReadiness,
  listConsumableRequirements,
  recordConsumableReadiness,
  updateConsumableRequirement,
};
