import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import {
  safetyInspectionBindingAlreadyExistsError,
  safetyInspectionBindingAmbiguousError,
  safetyInspectionBindingNotFoundError,
} from './safety-inspection-binding.errors';
import { safetyInspectionBindingRepository } from './safety-inspection-binding.repository';
import type {
  CreateSafetyInspectionBindingInput,
  PublicSafetyInspectionBinding,
  SafetyInspectionBindingRecord,
  SafetyInspectionBindingStatus,
  UpdateSafetyInspectionBindingInput,
} from './safety-inspection-binding.types';

type ScheduleRow = {
  id: string;
  client_id: string;
  building_id: string | null;
  target_type: string;
  target_id: string;
  status: string;
};

type BuildingClientRow = {
  client_id: string;
};

type ChecklistTemplateRow = {
  id: string;
  client_id: string;
  status: string;
};

function toPublic(
  record: SafetyInspectionBindingRecord,
): PublicSafetyInspectionBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    scheduleDefinitionId: record.scheduleDefinitionId,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Resolve the Schedule Definition and prove the complete ACTIVE binding
 * contract. The schedule's Building is the authority for both Building access
 * and Client alignment; the checklist template is only accepted when it is
 * ACTIVE and belongs to that same Client.
 */
async function validateScheduleDefinition(
  scheduleDefinitionId: string,
  userId: string,
): Promise<{ clientId: string; buildingId: string }> {
  const scheduleResult = await getPool().query<ScheduleRow>(
    `SELECT id, client_id, building_id, target_type, target_id, status
       FROM schedule_definitions
      WHERE id = $1`,
    [scheduleDefinitionId],
  );
  const schedule = scheduleResult.rows.at(0);
  if (!schedule) {
    throw AppError.notFound('Schedule definition not found.');
  }
  if (!schedule.building_id) {
    throw AppError.badRequest(
      'Safety Inspection schedules must be assigned to a Building.',
    );
  }

  await contextAccessService.assertBuildingAccess(userId, schedule.building_id);

  const buildingResult = await getPool().query<BuildingClientRow>(
    `SELECT p.client_id
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [schedule.building_id],
  );
  const building = buildingResult.rows.at(0);
  if (!building || building.client_id !== schedule.client_id) {
    throw AppError.badRequest(
      'The schedule definition and Building do not belong to the same Client.',
    );
  }
  if (schedule.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'An ACTIVE Safety Inspection binding requires an ACTIVE schedule definition.',
    );
  }
  if (schedule.target_type !== 'CHECKLIST_TEMPLATE') {
    throw AppError.badRequest(
      'The Safety Inspection schedule must target a CHECKLIST_TEMPLATE.',
    );
  }

  const templateResult = await getPool().query<ChecklistTemplateRow>(
    `SELECT id, client_id, status
       FROM checklist_templates
      WHERE id = $1`,
    [schedule.target_id],
  );
  const template = templateResult.rows.at(0);
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.client_id !== schedule.client_id) {
    throw AppError.badRequest(
      'The checklist template and schedule definition do not belong to the same Client.',
    );
  }
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'An ACTIVE Safety Inspection binding requires an ACTIVE checklist template.',
    );
  }

  return { clientId: schedule.client_id, buildingId: schedule.building_id };
}

async function assertNoActiveBindingConflict(
  scheduleDefinitionId: string,
): Promise<void> {
  const active = await safetyInspectionBindingRepository.listActiveBySchedule(
    scheduleDefinitionId,
  );
  if (active.length > 1) {
    throw safetyInspectionBindingAmbiguousError();
  }
  if (active.length === 1) {
    throw safetyInspectionBindingAlreadyExistsError();
  }
}

function isActiveUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint ===
      'safety_inspection_bindings_schedule_active_unique'
  );
}

export async function createSafetyInspectionBinding(
  input: CreateSafetyInspectionBindingInput,
  userId: string,
): Promise<PublicSafetyInspectionBinding> {
  const { clientId, buildingId } = await validateScheduleDefinition(
    input.scheduleDefinitionId,
    userId,
  );
  const status: SafetyInspectionBindingStatus = input.status ?? 'ACTIVE';

  if (status === 'ACTIVE') {
    await assertNoActiveBindingConflict(input.scheduleDefinitionId);
  }

  try {
    const record = await safetyInspectionBindingRepository.create({
      clientId,
      buildingId,
      scheduleDefinitionId: input.scheduleDefinitionId,
      status,
    });
    return toPublic(record);
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw safetyInspectionBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getSafetyInspectionBinding(
  id: string,
  userId: string,
): Promise<PublicSafetyInspectionBinding> {
  const record = await safetyInspectionBindingRepository.findById(id);
  if (!record) {
    throw safetyInspectionBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublic(record);
}

export async function updateSafetyInspectionBinding(
  id: string,
  input: UpdateSafetyInspectionBindingInput,
  userId: string,
): Promise<PublicSafetyInspectionBinding> {
  const record = await safetyInspectionBindingRepository.findById(id);
  if (!record) {
    throw safetyInspectionBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  if (input.status === 'ACTIVE') {
    await validateScheduleDefinition(record.scheduleDefinitionId, userId);
    const active = await safetyInspectionBindingRepository.listActiveBySchedule(
      record.scheduleDefinitionId,
    );
    if (active.length > 1) {
      throw safetyInspectionBindingAmbiguousError();
    }
    if (active.length === 1 && active.some((candidate) => candidate.id !== record.id)) {
      throw safetyInspectionBindingAlreadyExistsError();
    }
  }

  try {
    const updated = await safetyInspectionBindingRepository.updateStatus(
      record.id,
      input.status,
    );
    if (!updated) {
      throw safetyInspectionBindingNotFoundError();
    }
    return toPublic(updated);
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw safetyInspectionBindingAlreadyExistsError();
    }
    throw error;
  }
}

export const safetyInspectionBindingService = {
  createSafetyInspectionBinding,
  getSafetyInspectionBinding,
  updateSafetyInspectionBinding,
};
