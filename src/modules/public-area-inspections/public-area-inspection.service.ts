import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { areaNotFoundError, areaRepository } from '../areas';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  cleaningAreaInactiveError,
  cleaningAreaNotFoundError,
  cleaningAreaRepository,
} from '../cleaning-areas';
import { floorNotFoundError, floorRepository } from '../floors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { roomNotFoundError, roomRepository } from '../rooms';
import { resolveRoomBuildingId } from '../spaces';
import {
  publicAreaInspectionBindingAlreadyExistsError,
  publicAreaInspectionBindingInactiveError,
  publicAreaInspectionBindingNotFoundError,
  publicAreaInspectionExecutionNotFoundError,
  publicAreaInspectionLocationMismatchError,
  publicAreaInspectionTemplateClientMismatchError,
} from './public-area-inspection.errors';
import {
  publicAreaInspectionRepository,
  type PublicAreaExecutionContextRow,
} from './public-area-inspection.repository';
import type {
  CreatePublicAreaInspectionBindingInput,
  PublicAreaInspectionBindingFilter,
  PublicAreaInspectionBindingRecord,
  PublicPublicAreaInspectionBinding,
  PublicPublicAreaInspectionExecutionContext,
  UpdatePublicAreaInspectionBindingInput,
} from './public-area-inspection.types';

export async function toPublicPublicAreaInspectionBinding(
  record: PublicAreaInspectionBindingRecord,
): Promise<PublicPublicAreaInspectionBinding> {
  const [area, template, floor, ar, room, fl] = await Promise.all([
    cleaningAreaRepository.findById(record.cleaningAreaId),
    getPool()
      .query<{ id: string; code: string; name: string; status: string }>(
        `SELECT id, code, name, status FROM checklist_templates WHERE id = $1`,
        [record.checklistTemplateId],
      )
      .then((r) => r.rows[0] ?? null),
    record.floorId
      ? floorRepository.findById(record.floorId)
      : Promise.resolve(null),
    record.areaId
      ? areaRepository.findById(record.areaId)
      : Promise.resolve(null),
    record.roomId
      ? roomRepository.findById(record.roomId)
      : Promise.resolve(null),
    record.functionalLocationId
      ? functionalLocationRepository.findById(record.functionalLocationId)
      : Promise.resolve(null),
  ]);

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    cleaningAreaId: record.cleaningAreaId,
    checklistTemplateId: record.checklistTemplateId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    functionalLocationId: record.functionalLocationId,
    description: record.description,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
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
    ...(template
      ? {
          checklistTemplate: {
            id: template.id,
            code: template.code,
            name: template.name,
            status: template.status,
          },
        }
      : {}),
    floor: floor
      ? {
          id: floor.id,
          code: floor.code,
          name: floor.name,
        }
      : null,
    area: ar
      ? {
          id: ar.id,
          code: ar.code,
          name: ar.name,
        }
      : null,
    room: room
      ? {
          id: room.id,
          code: room.code,
          name: room.name,
        }
      : null,
    functionalLocation: fl
      ? {
          id: fl.id,
          code: fl.code,
          name: fl.name,
          status: fl.status,
        }
      : null,
  };
}

export function toPublicExecutionContext(
  row: PublicAreaExecutionContextRow,
): PublicPublicAreaInspectionExecutionContext {
  return {
    execution: {
      id: row.execution_id,
      checklistTemplateId: row.execution_checklist_template_id,
      publicAreaInspectionBindingId: row.binding_id,
      status: row.execution_status,
      startedAt: row.execution_started_at
        ? row.execution_started_at.toISOString()
        : null,
      completedAt: row.execution_completed_at
        ? row.execution_completed_at.toISOString()
        : null,
      createdAt: row.execution_created_at.toISOString(),
      updatedAt: row.execution_updated_at.toISOString(),
    },
    publicAreaInspectionBinding: {
      id: row.binding_id,
      clientId: row.client_id,
      buildingId: row.building_id,
      cleaningAreaId: row.cleaning_area_id,
      checklistTemplateId: row.checklist_template_id,
      floorId: row.floor_id,
      areaId: row.area_id,
      roomId: row.room_id,
      functionalLocationId: row.functional_location_id,
      description: row.binding_description,
      status: row.binding_status,
      createdByUserId: row.binding_created_by_user_id,
      createdAt: row.binding_created_at.toISOString(),
      updatedAt: row.binding_updated_at.toISOString(),
      cleaningArea: {
        id: row.cleaning_area_id,
        code: row.cleaning_area_code,
        name: row.cleaning_area_name,
        cleaningAreaType: row.cleaning_area_type,
        status: row.cleaning_area_status,
      },
      checklistTemplate: {
        id: row.checklist_template_id,
        code: row.template_code,
        name: row.template_name,
        status: row.template_status,
      },
      floor: row.floor_id
        ? {
            id: row.floor_id,
            code: row.floor_code!,
            name: row.floor_name!,
          }
        : null,
      area: row.area_id
        ? {
            id: row.area_id,
            code: row.area_code!,
            name: row.area_name!,
          }
        : null,
      room: row.room_id
        ? {
            id: row.room_id,
            code: row.room_code!,
            name: row.room_name!,
          }
        : null,
      functionalLocation: row.functional_location_id
        ? {
            id: row.functional_location_id,
            code: row.functional_location_code!,
            name: row.functional_location_name!,
            status: row.functional_location_status!,
          }
        : null,
    },
  };
}

export async function createPublicAreaInspectionBinding(
  input: CreatePublicAreaInspectionBindingInput,
): Promise<PublicPublicAreaInspectionBinding> {
  const cleaningArea = await cleaningAreaRepository.findById(
    input.cleaningAreaId,
  );
  if (!cleaningArea) {
    throw cleaningAreaNotFoundError();
  }
  if (cleaningArea.status !== 'ACTIVE') {
    throw cleaningAreaInactiveError();
  }

  const templateResult = await getPool().query<{
    id: string;
    client_id: string;
    status: string;
  }>(`SELECT id, client_id, status FROM checklist_templates WHERE id = $1`, [
    input.checklistTemplateId,
  ]);
  const template = templateResult.rows[0];
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive checklist template cannot receive an active binding.',
    );
  }
  if (template.client_id !== cleaningArea.clientId) {
    throw publicAreaInspectionTemplateClientMismatchError();
  }

  if (input.floorId) {
    const floor = await floorRepository.findById(input.floorId);
    if (!floor) {
      throw floorNotFoundError();
    }
    if (floor.buildingId !== cleaningArea.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced floor does not belong to this building.',
      );
    }
  }

  if (input.areaId) {
    const ar = await areaRepository.findById(input.areaId);
    if (!ar) {
      throw areaNotFoundError();
    }
    const floor = await floorRepository.findById(ar.floorId);
    if (!floor || floor.buildingId !== cleaningArea.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced area does not belong to this building.',
      );
    }
  }

  if (input.roomId) {
    const room = await roomRepository.findById(input.roomId);
    if (!room) {
      throw roomNotFoundError();
    }
    const roomBuildingId = await resolveRoomBuildingId(room.id);
    if (roomBuildingId !== cleaningArea.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced room does not belong to this building.',
      );
    }
  }

  if (input.functionalLocationId) {
    const fl = await functionalLocationRepository.findById(
      input.functionalLocationId,
    );
    if (!fl) {
      throw functionalLocationNotFoundError();
    }
    if (fl.buildingId !== cleaningArea.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }

  const activeExisting =
    await publicAreaInspectionRepository.findActiveByAreaAndTemplate(
      input.cleaningAreaId,
      input.checklistTemplateId,
    );
  if (activeExisting) {
    throw publicAreaInspectionBindingAlreadyExistsError();
  }

  const record = await publicAreaInspectionRepository.create({
    clientId: cleaningArea.clientId,
    buildingId: cleaningArea.buildingId,
    cleaningAreaId: input.cleaningAreaId,
    checklistTemplateId: input.checklistTemplateId,
    floorId: input.floorId ?? null,
    areaId: input.areaId ?? null,
    roomId: input.roomId ?? null,
    functionalLocationId: input.functionalLocationId ?? null,
    description: input.description ?? null,
    status: input.status ?? 'ACTIVE',
    createdByUserId: input.createdByUserId,
  });

  return toPublicPublicAreaInspectionBinding(record);
}

export async function getPublicAreaInspectionBindingById(
  id: string,
): Promise<PublicPublicAreaInspectionBinding> {
  const record = await publicAreaInspectionRepository.findById(id);
  if (!record) {
    throw publicAreaInspectionBindingNotFoundError();
  }
  return toPublicPublicAreaInspectionBinding(record);
}

export async function listPublicAreaInspectionBindings(
  filter: PublicAreaInspectionBindingFilter = {},
): Promise<PublicPublicAreaInspectionBinding[]> {
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

  const records = await publicAreaInspectionRepository.list(filter);
  return Promise.all(records.map(toPublicPublicAreaInspectionBinding));
}

export async function updatePublicAreaInspectionBinding(
  id: string,
  input: UpdatePublicAreaInspectionBindingInput,
): Promise<PublicPublicAreaInspectionBinding> {
  const existing = await publicAreaInspectionRepository.findById(id);
  if (!existing) {
    throw publicAreaInspectionBindingNotFoundError();
  }

  if (input.floorId) {
    const floor = await floorRepository.findById(input.floorId);
    if (!floor) {
      throw floorNotFoundError();
    }
    if (floor.buildingId !== existing.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced floor does not belong to this building.',
      );
    }
  }

  if (input.areaId) {
    const ar = await areaRepository.findById(input.areaId);
    if (!ar) {
      throw areaNotFoundError();
    }
    const floor = await floorRepository.findById(ar.floorId);
    if (!floor || floor.buildingId !== existing.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced area does not belong to this building.',
      );
    }
  }

  if (input.roomId) {
    const room = await roomRepository.findById(input.roomId);
    if (!room) {
      throw roomNotFoundError();
    }
    const roomBuildingId = await resolveRoomBuildingId(room.id);
    if (roomBuildingId !== existing.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced room does not belong to this building.',
      );
    }
  }

  if (input.functionalLocationId) {
    const fl = await functionalLocationRepository.findById(
      input.functionalLocationId,
    );
    if (!fl) {
      throw functionalLocationNotFoundError();
    }
    if (fl.buildingId !== existing.buildingId) {
      throw publicAreaInspectionLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }

  const record = await publicAreaInspectionRepository.update(id, input);
  return toPublicPublicAreaInspectionBinding(
    record as PublicAreaInspectionBindingRecord,
  );
}

export async function startPublicAreaInspectionExecution(
  bindingId: string,
): Promise<PublicPublicAreaInspectionExecutionContext> {
  const binding = await publicAreaInspectionRepository.findById(bindingId);
  if (!binding) {
    throw publicAreaInspectionBindingNotFoundError();
  }
  if (binding.status !== 'ACTIVE') {
    throw publicAreaInspectionBindingInactiveError();
  }

  const area = await cleaningAreaRepository.findById(binding.cleaningAreaId);
  if (!area || area.status !== 'ACTIVE') {
    throw cleaningAreaInactiveError();
  }

  const execution = await publicAreaInspectionRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    checklistTemplateId: binding.checklistTemplateId,
  });

  const context = await publicAreaInspectionRepository.findExecutionContext(
    execution.id,
  );
  if (!context) {
    throw publicAreaInspectionExecutionNotFoundError();
  }
  return toPublicExecutionContext(context);
}

export async function getPublicAreaInspectionExecutionContext(
  executionId: string,
): Promise<PublicPublicAreaInspectionExecutionContext> {
  const context = await publicAreaInspectionRepository.findExecutionContext(
    executionId,
  );
  if (!context) {
    throw publicAreaInspectionExecutionNotFoundError();
  }
  return toPublicExecutionContext(context);
}

export const publicAreaInspectionService = {
  createPublicAreaInspectionBinding,
  getPublicAreaInspectionBindingById,
  getPublicAreaInspectionExecutionContext,
  listPublicAreaInspectionBindings,
  startPublicAreaInspectionExecution,
  toPublicPublicAreaInspectionBinding,
  updatePublicAreaInspectionBinding,
};
