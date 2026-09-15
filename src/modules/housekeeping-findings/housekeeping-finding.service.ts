import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingService } from '../buildings';
import {
  cleaningAreaNotFoundError,
  cleaningAreaRepository,
} from '../cleaning-areas';
import { dailyCleaningRepository } from '../daily-cleaning';
import {
  findingActionService,
  findingService,
  findingSourceService,
} from '../findings';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { supervisorInspectionRepository } from '../supervisor-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import {
  housekeepingFindingAlreadyLinkedError,
  housekeepingFindingBuildingMismatchError,
  housekeepingFindingClientMismatchError,
  housekeepingFindingNotFoundError,
  housekeepingFindingSourceNotFoundError,
} from './housekeeping-finding.errors';
import {
  housekeepingFindingRepository,
  type HousekeepingFindingWithFindingRow,
} from './housekeeping-finding.repository';
import type {
  CreateHousekeepingFindingInput,
  HousekeepingFindingFilter,
  HousekeepingFindingSourceType,
  PublicHousekeepingFinding,
} from './housekeeping-finding.types';

type ResolvedSource = {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  sourceType: string;
  sourceId: string;
};

async function resolveHousekeepingSource(
  sourceType: HousekeepingFindingSourceType,
  sourceId: string,
  buildingId: string,
): Promise<ResolvedSource> {
  if (sourceType === 'DAILY_CLEANING') {
    const task = await dailyCleaningRepository.findById(sourceId);
    if (!task) {
      throw housekeepingFindingSourceNotFoundError();
    }
    if (task.building_id !== buildingId) {
      throw housekeepingFindingBuildingMismatchError();
    }
    return {
      clientId: task.client_id,
      buildingId: task.building_id,
      cleaningAreaId: task.cleaning_area_id,
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: task.task_id,
    };
  }

  if (sourceType === 'TOILET_INSPECTION') {
    const context = await toiletInspectionRepository.findExecutionContext(
      sourceId,
    );
    if (!context) {
      throw housekeepingFindingSourceNotFoundError();
    }
    if (context.building_id !== buildingId) {
      throw housekeepingFindingBuildingMismatchError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: context.execution_id,
    };
  }

  if (sourceType === 'PUBLIC_AREA_INSPECTION') {
    const context = await publicAreaInspectionRepository.findExecutionContext(
      sourceId,
    );
    if (!context) {
      throw housekeepingFindingSourceNotFoundError();
    }
    if (context.building_id !== buildingId) {
      throw housekeepingFindingBuildingMismatchError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: context.execution_id,
    };
  }

  if (sourceType === 'SUPERVISOR_INSPECTION') {
    const inspection = await supervisorInspectionRepository.findById(sourceId);
    if (!inspection) {
      throw housekeepingFindingSourceNotFoundError();
    }
    if (inspection.buildingId !== buildingId) {
      throw housekeepingFindingBuildingMismatchError();
    }
    return {
      clientId: inspection.clientId,
      buildingId: inspection.buildingId,
      cleaningAreaId: inspection.cleaningAreaId,
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: inspection.targetId,
    };
  }

  throw housekeepingFindingSourceNotFoundError();
}

export async function toPublicHousekeepingFinding(
  row: HousekeepingFindingWithFindingRow,
  userId?: string,
): Promise<PublicHousekeepingFinding> {
  const area = await cleaningAreaRepository.findById(row.cleaning_area_id);

  let availableActions: readonly string[] = [];
  if (userId) {
    try {
      const actions = await findingActionService.resolveAvailableActions(
        row.finding_id,
        { userId },
      );
      availableActions = actions.availableActions;
    } catch {
      // Ignored if user context not resolved
    }
  }

  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingId: row.finding_id,
    cleaningAreaId: row.cleaning_area_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    roomId: row.room_id,
    functionalLocationId: row.functional_location_id,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finding: {
      id: row.finding_id,
      findingNumber: row.finding_number,
      title: row.finding_title,
      description: row.finding_description,
      status: row.finding_status,
      reportedByUserId: row.finding_reported_by_user_id,
      reportedAt: row.finding_reported_at.toISOString(),
    },
    ...(area
      ? {
          cleaningArea: {
            id: area.id,
            code: area.code,
            name: area.name,
            cleaningAreaType: area.cleaningAreaType,
            status: area.status,
          },
        }
      : {}),
    availableActions,
  };
}

export async function createHousekeepingFinding(
  input: CreateHousekeepingFindingInput,
  userId: string,
): Promise<PublicHousekeepingFinding> {
  const building = await buildingService.getBuildingById(input.buildingId);

  const cleaningArea = await cleaningAreaRepository.findById(
    input.cleaningAreaId,
  );
  if (!cleaningArea) {
    throw cleaningAreaNotFoundError();
  }
  if (cleaningArea.buildingId !== building.id) {
    throw housekeepingFindingBuildingMismatchError();
  }

  const source = await resolveHousekeepingSource(
    input.sourceType,
    input.sourceId,
    building.id,
  );
  if (source.cleaningAreaId !== input.cleaningAreaId) {
    throw AppError.badRequest(
      'Cleaning area does not match the operational source.',
    );
  }

  // Create BE-09 Finding
  const findingNumber =
    input.findingNumber ?? `FND_HK_${randomUUID().slice(0, 8).toUpperCase()}`;
  const finding = await findingService.createFinding({
    clientId: source.clientId,
    buildingId: building.id,
    findingNumber,
    title: input.title,
    description: input.description ?? undefined,
    reportedByUserId: userId,
  });

  // Attach BE-09 source binding if target is a known BE-09 source (e.g. CHECKLIST_EXECUTION)
  if (source.sourceType === 'CHECKLIST_EXECUTION') {
    const isExecution = await getPool().query(
      'SELECT id FROM checklist_executions WHERE id = $1',
      [source.sourceId],
    );
    if (isExecution.rowCount) {
      await findingSourceService.updateFindingSource(finding.id, {
        sourceType: 'CHECKLIST_EXECUTION',
        sourceId: source.sourceId,
      });
    }
  }

  const record = await housekeepingFindingRepository.create({
    clientId: source.clientId,
    buildingId: building.id,
    findingId: finding.id,
    cleaningAreaId: input.cleaningAreaId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    floorId: input.floorId ?? null,
    areaId: input.areaId ?? null,
    roomId: input.roomId ?? null,
    functionalLocationId: input.functionalLocationId ?? null,
    notes: input.notes ?? null,
    createdByUserId: userId,
  });

  const fullRow = await housekeepingFindingRepository.findById(record.id);
  return toPublicHousekeepingFinding(fullRow!, userId);
}

export async function getHousekeepingFindingById(
  id: string,
  userId: string,
): Promise<PublicHousekeepingFinding> {
  const row = await housekeepingFindingRepository.findById(id);
  if (!row) {
    throw housekeepingFindingNotFoundError();
  }
  return toPublicHousekeepingFinding(row, userId);
}

export async function listHousekeepingFindings(
  filter: HousekeepingFindingFilter = {},
  userId: string,
): Promise<PublicHousekeepingFinding[]> {
  const rows = await housekeepingFindingRepository.list(filter);
  return Promise.all(
    rows.map((row) => toPublicHousekeepingFinding(row, userId)),
  );
}

export const housekeepingFindingService = {
  createHousekeepingFinding,
  getHousekeepingFindingById,
  listHousekeepingFindings,
  toPublicHousekeepingFinding,
};
