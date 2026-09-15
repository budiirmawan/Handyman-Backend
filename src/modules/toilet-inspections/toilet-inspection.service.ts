import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  cleaningAreaInactiveError,
  cleaningAreaNotFoundError,
  cleaningAreaRepository,
} from '../cleaning-areas';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { roomNotFoundError, roomRepository } from '../rooms';
import { resolveRoomBuildingId } from '../spaces';
import {
  toiletInspectionBindingAlreadyExistsError,
  toiletInspectionBindingInactiveError,
  toiletInspectionBindingNotFoundError,
  toiletInspectionExecutionNotFoundError,
  toiletInspectionLocationMismatchError,
  toiletInspectionTemplateClientMismatchError,
} from './toilet-inspection.errors';
import {
  toiletInspectionRepository,
  type ToiletExecutionContextRow,
} from './toilet-inspection.repository';
import type {
  CreateToiletInspectionBindingInput,
  PublicToiletInspectionBinding,
  PublicToiletInspectionExecutionContext,
  ToiletInspectionBindingFilter,
  ToiletInspectionBindingRecord,
  UpdateToiletInspectionBindingInput,
} from './toilet-inspection.types';

export async function toPublicToiletInspectionBinding(
  record: ToiletInspectionBindingRecord,
): Promise<PublicToiletInspectionBinding> {
  const [area, template, room, fl] = await Promise.all([
    cleaningAreaRepository.findById(record.cleaningAreaId),
    getPool()
      .query<{ id: string; code: string; name: string; status: string }>(
        `SELECT id, code, name, status FROM checklist_templates WHERE id = $1`,
        [record.checklistTemplateId],
      )
      .then((r) => r.rows[0] ?? null),
    record.roomId ? roomRepository.findById(record.roomId) : Promise.resolve(null),
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
  row: ToiletExecutionContextRow,
): PublicToiletInspectionExecutionContext {
  return {
    execution: {
      id: row.execution_id,
      checklistTemplateId: row.execution_checklist_template_id,
      toiletInspectionBindingId: row.binding_id,
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
    toiletInspectionBinding: {
      id: row.binding_id,
      clientId: row.client_id,
      buildingId: row.building_id,
      cleaningAreaId: row.cleaning_area_id,
      checklistTemplateId: row.checklist_template_id,
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

export async function createToiletInspectionBinding(
  input: CreateToiletInspectionBindingInput,
): Promise<PublicToiletInspectionBinding> {
  const area = await cleaningAreaRepository.findById(input.cleaningAreaId);
  if (!area) {
    throw cleaningAreaNotFoundError();
  }
  if (area.status !== 'ACTIVE') {
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
  if (template.client_id !== area.clientId) {
    throw toiletInspectionTemplateClientMismatchError();
  }

  if (input.roomId) {
    const room = await roomRepository.findById(input.roomId);
    if (!room) {
      throw roomNotFoundError();
    }
    const roomBuildingId = await resolveRoomBuildingId(room.id);
    if (roomBuildingId !== area.buildingId) {
      throw toiletInspectionLocationMismatchError(
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
    if (fl.buildingId !== area.buildingId) {
      throw toiletInspectionLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }

  const activeExisting =
    await toiletInspectionRepository.findActiveByAreaAndTemplate(
      input.cleaningAreaId,
      input.checklistTemplateId,
    );
  if (activeExisting) {
    throw toiletInspectionBindingAlreadyExistsError();
  }

  const record = await toiletInspectionRepository.create({
    clientId: area.clientId,
    buildingId: area.buildingId,
    cleaningAreaId: input.cleaningAreaId,
    checklistTemplateId: input.checklistTemplateId,
    roomId: input.roomId ?? null,
    functionalLocationId: input.functionalLocationId ?? null,
    description: input.description ?? null,
    status: input.status ?? 'ACTIVE',
    createdByUserId: input.createdByUserId,
  });

  return toPublicToiletInspectionBinding(record);
}

export async function getToiletInspectionBindingById(
  id: string,
): Promise<PublicToiletInspectionBinding> {
  const record = await toiletInspectionRepository.findById(id);
  if (!record) {
    throw toiletInspectionBindingNotFoundError();
  }
  return toPublicToiletInspectionBinding(record);
}

export async function listToiletInspectionBindings(
  filter: ToiletInspectionBindingFilter = {},
): Promise<PublicToiletInspectionBinding[]> {
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

  const records = await toiletInspectionRepository.list(filter);
  return Promise.all(records.map(toPublicToiletInspectionBinding));
}

export async function updateToiletInspectionBinding(
  id: string,
  input: UpdateToiletInspectionBindingInput,
): Promise<PublicToiletInspectionBinding> {
  const existing = await toiletInspectionRepository.findById(id);
  if (!existing) {
    throw toiletInspectionBindingNotFoundError();
  }

  if (input.roomId) {
    const room = await roomRepository.findById(input.roomId);
    if (!room) {
      throw roomNotFoundError();
    }
    const roomBuildingId = await resolveRoomBuildingId(room.id);
    if (roomBuildingId !== existing.buildingId) {
      throw toiletInspectionLocationMismatchError(
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
      throw toiletInspectionLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }

  const record = await toiletInspectionRepository.update(id, input);
  return toPublicToiletInspectionBinding(
    record as ToiletInspectionBindingRecord,
  );
}

export async function startToiletInspectionExecution(
  bindingId: string,
): Promise<PublicToiletInspectionExecutionContext> {
  const binding = await toiletInspectionRepository.findById(bindingId);
  if (!binding) {
    throw toiletInspectionBindingNotFoundError();
  }
  if (binding.status !== 'ACTIVE') {
    throw toiletInspectionBindingInactiveError();
  }

  const area = await cleaningAreaRepository.findById(binding.cleaningAreaId);
  if (!area || area.status !== 'ACTIVE') {
    throw cleaningAreaInactiveError();
  }

  const execution = await toiletInspectionRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    checklistTemplateId: binding.checklistTemplateId,
  });

  const context = await toiletInspectionRepository.findExecutionContext(
    execution.id,
  );
  if (!context) {
    throw toiletInspectionExecutionNotFoundError();
  }
  return toPublicExecutionContext(context);
}

export async function getToiletInspectionExecutionContext(
  executionId: string,
): Promise<PublicToiletInspectionExecutionContext> {
  const context = await toiletInspectionRepository.findExecutionContext(
    executionId,
  );
  if (!context) {
    throw toiletInspectionExecutionNotFoundError();
  }
  return toPublicExecutionContext(context);
}

export const toiletInspectionService = {
  createToiletInspectionBinding,
  getToiletInspectionBindingById,
  getToiletInspectionExecutionContext,
  listToiletInspectionBindings,
  startToiletInspectionExecution,
  toPublicToiletInspectionBinding,
  updateToiletInspectionBinding,
};
