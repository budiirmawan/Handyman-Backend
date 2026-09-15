import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  cleaningAreaBuildingMismatchError,
  cleaningAreaNotFoundError,
  cleaningAreaRepository,
} from '../cleaning-areas';
import { dailyCleaningRepository } from '../daily-cleaning';
import { findingRepository } from '../findings/finding.repository';
import { propertyNotFoundError, propertyRepository } from '../properties';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { supervisorInspectionRepository } from '../supervisor-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import { workOrderRepository } from '../work-orders';
import {
  housekeepingComplaintBindingAlreadyExistsError,
  housekeepingComplaintBindingNotFoundError,
  housekeepingComplaintBuildingMismatchError,
  housekeepingComplaintClientMismatchError,
  housekeepingComplaintSourceNotFoundError,
} from './housekeeping-complaint.errors';
import {
  housekeepingComplaintRepository,
  type ComplaintBindingWithContextRow,
} from './housekeeping-complaint.repository';
import type {
  CreateHousekeepingComplaintBindingInput,
  HousekeepingComplaintBindingFilter,
  HousekeepingComplaintBindingRecord,
  HousekeepingComplaintSourceType,
  PublicHousekeepingComplaintBinding,
  UpdateHousekeepingComplaintBindingInput,
} from './housekeeping-complaint.types';

type ResolvedSource = {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
};

async function resolveSource(
  sourceType: HousekeepingComplaintSourceType,
  sourceId: string,
  buildingId: string,
): Promise<ResolvedSource> {
  if (sourceType === 'DAILY_CLEANING') {
    const task = await dailyCleaningRepository.findById(sourceId);
    if (!task) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (task.building_id !== buildingId) {
      throw housekeepingComplaintBuildingMismatchError();
    }
    return {
      clientId: task.client_id,
      buildingId: task.building_id,
      cleaningAreaId: task.cleaning_area_id,
    };
  }

  if (sourceType === 'TOILET_INSPECTION') {
    const context = await toiletInspectionRepository.findExecutionContext(
      sourceId,
    );
    if (!context) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (context.building_id !== buildingId) {
      throw housekeepingComplaintBuildingMismatchError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
    };
  }

  if (sourceType === 'PUBLIC_AREA_INSPECTION') {
    const context =
      await publicAreaInspectionRepository.findExecutionContext(sourceId);
    if (!context) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (context.building_id !== buildingId) {
      throw housekeepingComplaintBuildingMismatchError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
    };
  }

  if (sourceType === 'SUPERVISOR_INSPECTION') {
    const inspection = await supervisorInspectionRepository.findById(sourceId);
    if (!inspection) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (inspection.buildingId !== buildingId) {
      throw housekeepingComplaintBuildingMismatchError();
    }
    return {
      clientId: inspection.clientId,
      buildingId: inspection.buildingId,
      cleaningAreaId: inspection.cleaningAreaId,
    };
  }

  if (sourceType === 'CLEANING_AREA') {
    const area = await cleaningAreaRepository.findById(sourceId);
    if (!area) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (area.buildingId !== buildingId) {
      throw housekeepingComplaintBuildingMismatchError();
    }
    return {
      clientId: area.clientId,
      buildingId: area.buildingId,
      cleaningAreaId: area.id,
    };
  }

  throw housekeepingComplaintSourceNotFoundError();
}

export function toPublicComplaintBinding(
  row: ComplaintBindingWithContextRow | HousekeepingComplaintBindingRecord,
): PublicHousekeepingComplaintBinding {
  const isContextRow = 'client_id' in row;
  const ctx = isContextRow ? (row as ComplaintBindingWithContextRow) : null;
  const rec = !isContextRow
    ? (row as HousekeepingComplaintBindingRecord)
    : null;

  const clientId = rec ? rec.clientId : ctx!.client_id;
  const buildingId = rec ? rec.buildingId : ctx!.building_id;
  const complaintReference = rec
    ? rec.complaintReference
    : ctx!.complaint_reference;
  const workRequestId = rec ? rec.workRequestId : ctx!.work_request_id;
  const cleaningAreaId = rec ? rec.cleaningAreaId : ctx!.cleaning_area_id;
  const housekeepingSourceType = rec
    ? rec.housekeepingSourceType
    : ctx!.housekeeping_source_type;
  const housekeepingSourceId = rec
    ? rec.housekeepingSourceId
    : ctx!.housekeeping_source_id;
  const findingId = rec ? rec.findingId : ctx!.finding_id;
  const description = rec ? rec.description : ctx!.description;
  const status = rec ? rec.status : ctx!.status;
  const createdByUserId = rec
    ? rec.createdByUserId
    : ctx!.created_by_user_id;
  const createdAt = rec ? rec.createdAt : ctx!.created_at;
  const updatedAt = rec ? rec.updatedAt : ctx!.updated_at;

  return {
    id: row.id,
    clientId,
    buildingId,
    complaintReference,
    workRequestId,
    cleaningAreaId,
    housekeepingSourceType,
    housekeepingSourceId,
    findingId,
    description,
    status,
    createdByUserId,
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
    finding:
      ctx && ctx.finding_number
        ? {
            id: ctx.finding_id!,
            findingNumber: ctx.finding_number,
            title: ctx.finding_title!,
            status: ctx.finding_status!,
          }
        : null,
    workRequest:
      ctx && ctx.work_request_number
        ? {
            id: ctx.work_request_id!,
            requestNumber: ctx.work_request_number,
            title: ctx.work_request_title!,
            status: ctx.work_request_status!,
          }
        : null,
  };
}

export async function createHousekeepingComplaintBinding(
  input: CreateHousekeepingComplaintBindingInput,
): Promise<PublicHousekeepingComplaintBinding> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  const clientId = property.clientId;

  let cleaningAreaId = input.cleaningAreaId ?? null;

  if (input.housekeepingSourceType && input.housekeepingSourceId) {
    const source = await resolveSource(
      input.housekeepingSourceType,
      input.housekeepingSourceId,
      input.buildingId,
    );
    if (source.clientId !== clientId) {
      throw housekeepingComplaintClientMismatchError();
    }
    if (source.cleaningAreaId && !cleaningAreaId) {
      cleaningAreaId = source.cleaningAreaId;
    }
  }

  if (input.cleaningAreaId) {
    const area = await cleaningAreaRepository.findById(input.cleaningAreaId);
    if (!area) {
      throw cleaningAreaNotFoundError();
    }
    if (area.buildingId !== input.buildingId) {
      throw cleaningAreaBuildingMismatchError();
    }
  }

  if (input.findingId) {
    const finding = await findingRepository.findById(input.findingId);
    if (!finding) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (finding.buildingId !== input.buildingId) {
      throw housekeepingComplaintBuildingMismatchError();
    }
  }

  if (input.housekeepingSourceId) {
    const activeExisting =
      await housekeepingComplaintRepository.findActiveByReferenceAndSource(
        input.complaintReference,
        input.housekeepingSourceType ?? null,
        input.housekeepingSourceId,
      );
    if (activeExisting) {
      throw housekeepingComplaintBindingAlreadyExistsError();
    }
  }

  const record = await housekeepingComplaintRepository.create({
    clientId,
    buildingId: input.buildingId,
    complaintReference: input.complaintReference,
    workRequestId: input.workRequestId ?? null,
    cleaningAreaId,
    housekeepingSourceType: input.housekeepingSourceType ?? null,
    housekeepingSourceId: input.housekeepingSourceId ?? null,
    findingId: input.findingId ?? null,
    description: input.description ?? null,
    status: input.status ?? 'ACTIVE',
    createdByUserId: input.createdByUserId,
  });

  const full = await housekeepingComplaintRepository.findById(record.id);
  return toPublicComplaintBinding(full!);
}

export async function getHousekeepingComplaintBindingById(
  id: string,
): Promise<PublicHousekeepingComplaintBinding> {
  const row = await housekeepingComplaintRepository.findById(id);
  if (!row) {
    throw housekeepingComplaintBindingNotFoundError();
  }
  return toPublicComplaintBinding(row);
}

export async function listHousekeepingComplaintBindings(
  filter: HousekeepingComplaintBindingFilter = {},
): Promise<PublicHousekeepingComplaintBinding[]> {
  if (filter.buildingId) {
    const building = await buildingRepository.findById(filter.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
  }

  const rows = await housekeepingComplaintRepository.list(filter);
  return rows.map(toPublicComplaintBinding);
}

export async function updateHousekeepingComplaintBinding(
  id: string,
  input: UpdateHousekeepingComplaintBindingInput,
): Promise<PublicHousekeepingComplaintBinding> {
  const existing = await housekeepingComplaintRepository.findById(id);
  if (!existing) {
    throw housekeepingComplaintBindingNotFoundError();
  }

  if (input.findingId) {
    const finding = await findingRepository.findById(input.findingId);
    if (!finding) {
      throw housekeepingComplaintSourceNotFoundError();
    }
    if (finding.buildingId !== existing.building_id) {
      throw housekeepingComplaintBuildingMismatchError();
    }
  }

  await housekeepingComplaintRepository.update(id, input);

  const full = await housekeepingComplaintRepository.findById(id);
  return toPublicComplaintBinding(full!);
}

export const housekeepingComplaintService = {
  createHousekeepingComplaintBinding,
  getHousekeepingComplaintBindingById,
  listHousekeepingComplaintBindings,
  toPublicComplaintBinding,
  updateHousekeepingComplaintBinding,
};
