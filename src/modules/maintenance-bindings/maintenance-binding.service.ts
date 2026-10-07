import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { getPool } from '../../database';
import {
  assetNotFoundError,
  assetRepository,
  assetRetiredError,
  resolveAssetBuildingContext,
} from '../assets';
import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import { workOrderService } from '../work-orders';
import {
  maintenanceBindingInactiveError,
  maintenanceBindingNotFoundError,
  maintenanceLocationBuildingMismatchError,
  maintenanceScheduleAlreadyLinkedError,
  maintenanceScheduleBuildingMismatchError,
  maintenanceTaskAlreadyLinkedError,
  maintenanceTaskBuildingMismatchError,
  maintenanceWorkOrderAlreadyLinkedError,
  maintenanceWorkOrderBuildingMismatchError,
} from './maintenance-binding.errors';
import {
  maintenanceBindingRepository,
  type ScheduleRow,
  type TaskRow,
  type WorkOrderRow,
} from './maintenance-binding.repository';
import {
  type CreateMaintenanceBindingInput,
  type LinkMaintenanceScheduleInput,
  type LinkMaintenanceTaskInput,
  type LinkMaintenanceWorkOrderInput,
  type MaintenanceBindingRecord,
  type PublicMaintenanceBinding,
  type UpdateMaintenanceBindingInput,
} from './maintenance-binding.types';

const SCHEDULE_TARGET_TABLES: Record<string, string> = {
  FORM_TEMPLATE: 'form_templates',
  FORM_VERSION: 'form_template_versions',
  CHECKLIST_TEMPLATE: 'checklist_templates',
};

/**
 * BE-10G — Maintenance Operational Binding service.
 *
 * Records maintenance contexts against BE-05 Assets and links shared BE-07
 * schedules / generated tasks and BE-08 Work Orders. Schedules, tasks, and
 * Work Orders are created and driven exclusively through the BE-07 / BE-08
 * engines; their lifecycle, assignments (BE-03/BE-06), evidence,
 * verification, and any Finding workflow remain theirs. The operational
 * context returned by this module is always projected from the linked
 * records' authoritative states — never stored.
 */
export async function createMaintenanceBinding(
  input: CreateMaintenanceBindingInput,
  userId: string,
): Promise<PublicMaintenanceBinding> {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  assertOperationalAsset(asset.status);

  const functionalLocationId = await assertMaintenanceLocation(
    input.functionalLocationId ?? null,
    asset.buildingId,
  );

  const { clientId } = await resolveAssetBuildingContext(asset.buildingId);

  const record = await maintenanceBindingRepository.create({
    clientId,
    buildingId: asset.buildingId,
    assetId: asset.id,
    functionalLocationId,
    name: input.name,
    maintenanceType: input.maintenanceType,
    description: input.description ?? null,
    status: input.status ?? 'ACTIVE',
    createdByUserId: userId,
  });

  await recordOperationalEvent({
    clientId,
    eventType: 'MAINTENANCE_BINDING_CREATED',
    entityType: 'MAINTENANCE_BINDING',
    entityId: record.id,
    actorUserId: userId,
    buildingId: asset.buildingId,
    summary: `Maintenance binding created for asset ${asset.assetCode}`,
    metadata: {
      assetId: asset.id,
      maintenanceType: input.maintenanceType,
      functionalLocationId,
    },
  });

  return toPublicMaintenanceBinding(record, null, null, []);
}

export async function getMaintenanceBinding(
  id: string,
  userId: string,
): Promise<PublicMaintenanceBinding> {
  const record = await maintenanceBindingRepository.findById(id);
  if (!record) {
    throw maintenanceBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return resolveMaintenanceContext(record);
}

export async function listMaintenanceBindingsByAsset(
  assetId: string,
  userId: string,
): Promise<PublicMaintenanceBinding[]> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  const records = await maintenanceBindingRepository.listByAssetId(assetId);
  return Promise.all(records.map((record) => resolveMaintenanceContext(record)));
}

export async function listMaintenanceBindingsByBuilding(
  buildingId: string,
  userId: string,
): Promise<PublicMaintenanceBinding[]> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const records = await maintenanceBindingRepository.listByBuildingId(building.id);
  return Promise.all(records.map((record) => resolveMaintenanceContext(record)));
}

export async function updateMaintenanceBinding(
  id: string,
  input: UpdateMaintenanceBindingInput,
  userId: string,
): Promise<PublicMaintenanceBinding> {
  const existing = await maintenanceBindingRepository.findById(id);
  if (!existing) {
    throw maintenanceBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const functionalLocationId =
    input.functionalLocationId !== undefined
      ? await assertMaintenanceLocation(
          input.functionalLocationId,
          existing.buildingId,
        )
      : undefined;

  const updated = await maintenanceBindingRepository.update(id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.maintenanceType === undefined ? {} : { maintenanceType: input.maintenanceType }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  if (!updated) {
    throw maintenanceBindingNotFoundError();
  }
  return resolveMaintenanceContext(updated);
}

/**
 * Links an existing shared BE-07 schedule or creates a new one (through the
 * same `schedule_definitions` table BE-07's schedule endpoint writes). The
 * schedule must resolve to the binding's Building so generated tasks can
 * never leave the maintenance context.
 */
export async function linkMaintenanceSchedule(
  id: string,
  input: LinkMaintenanceScheduleInput,
  userId: string,
): Promise<PublicMaintenanceBinding> {
  const binding = await maintenanceBindingRepository.findById(id);
  if (!binding) {
    throw maintenanceBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  assertActiveBinding(binding.status);
  if (binding.scheduleDefinitionId) {
    throw maintenanceScheduleAlreadyLinkedError();
  }

  let schedule: ScheduleRow;
  if (input.scheduleDefinitionId) {
    const existing = await maintenanceBindingRepository.findSchedule(
      input.scheduleDefinitionId,
    );
    if (!existing) {
      throw AppError.notFound('Schedule not found.');
    }
    if (existing.client_id !== binding.clientId) {
      throw maintenanceScheduleBuildingMismatchError();
    }
    if (existing.building_id !== binding.buildingId) {
      throw maintenanceScheduleBuildingMismatchError();
    }
    schedule = existing;
  } else {
    const target = await resolveScheduleTarget(
      input.targetType as string,
      input.targetId as string,
      binding.clientId,
    );
    if (!target) {
      throw AppError.badRequest('Schedule target does not exist.');
    }
    if (target.status !== 'ACTIVE') {
      throw AppError.badRequest('Inactive target cannot receive an active schedule.');
    }
    schedule = await maintenanceBindingRepository.insertSchedule({
      clientId: binding.clientId,
      buildingId: binding.buildingId,
      code: (input.code ?? `PM_${randomUUID().slice(0, 8).toUpperCase()}`).toUpperCase(),
      name: input.name as string,
      targetType: input.targetType as string,
      targetId: input.targetId as string,
      startAt: input.startAt as string,
      timezone: input.timezone as string,
    });
  }

  const updated = await maintenanceBindingRepository.linkSchedule(id, schedule.id);
  if (!updated) {
    throw maintenanceBindingNotFoundError();
  }

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'MAINTENANCE_SCHEDULE_LINKED',
    entityType: 'MAINTENANCE_BINDING',
    entityId: binding.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Maintenance schedule linked for asset ${binding.assetId}`,
    metadata: { scheduleDefinitionId: schedule.id },
  });

  return resolveMaintenanceContext(updated);
}

/** Links a BE-07 generated task that belongs to the binding's Building. */
export async function linkMaintenanceTask(
  id: string,
  input: LinkMaintenanceTaskInput,
  userId: string,
): Promise<PublicMaintenanceBinding> {
  const binding = await maintenanceBindingRepository.findById(id);
  if (!binding) {
    throw maintenanceBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  assertActiveBinding(binding.status);

  const task = await maintenanceBindingRepository.findTask(input.taskId);
  if (!task) {
    throw AppError.notFound('Generated task not found.');
  }
  if (task.building_id !== binding.buildingId || task.client_id !== binding.clientId) {
    throw maintenanceTaskBuildingMismatchError();
  }
  if (task.maintenance_binding_id && task.maintenance_binding_id !== binding.id) {
    throw maintenanceTaskAlreadyLinkedError();
  }

  await maintenanceBindingRepository.linkTask(task.id, binding.id);

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'MAINTENANCE_TASK_LINKED',
    entityType: 'MAINTENANCE_BINDING',
    entityId: binding.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Generated task linked to maintenance binding for asset ${binding.assetId}`,
    metadata: { taskId: task.id },
  });

  return resolveMaintenanceContext(await requireBinding(id, userId));
}

/** Links an existing BE-08 Work Order or creates a MAINTENANCE one via BE-08. */
export async function linkMaintenanceWorkOrder(
  id: string,
  input: LinkMaintenanceWorkOrderInput,
  userId: string,
): Promise<PublicMaintenanceBinding> {
  const binding = await maintenanceBindingRepository.findById(id);
  if (!binding) {
    throw maintenanceBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  assertActiveBinding(binding.status);
  if (binding.workOrderId) {
    throw maintenanceWorkOrderAlreadyLinkedError();
  }

  let workOrder: WorkOrderRow;
  if (input.workOrderId) {
    const existing = await maintenanceBindingRepository.findWorkOrder(
      input.workOrderId,
    );
    if (!existing) {
      throw AppError.notFound('Work order not found.');
    }
    if (existing.building_id !== binding.buildingId) {
      throw maintenanceWorkOrderBuildingMismatchError();
    }
    workOrder = existing;
  } else {
    const created = await workOrderService.createWorkOrder({
      clientId: binding.clientId,
      buildingId: binding.buildingId,
      workOrderNumber: `PM_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: input.title ?? `${binding.maintenanceType} maintenance: ${binding.name}`,
      workType: 'MAINTENANCE',
      createdByUserId: userId,
    });
    // BE-08 owns the Asset / Location context binding and its validation.
    await workOrderService.bindWorkOrderContext(created.id, {
      assetId: binding.assetId,
      functionalLocationId: binding.functionalLocationId,
    });
    workOrder = {
      id: created.id,
      work_order_number: created.workOrderNumber,
      title: created.title,
      status: created.status,
      building_id: created.buildingId,
    };
  }

  const updated = await maintenanceBindingRepository.linkWorkOrder(id, workOrder.id);
  if (!updated) {
    throw maintenanceBindingNotFoundError();
  }

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'MAINTENANCE_WORK_ORDER_LINKED',
    entityType: 'MAINTENANCE_BINDING',
    entityId: binding.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Maintenance work order linked for asset ${binding.assetId}`,
    metadata: { workOrderId: workOrder.id },
  });

  return resolveMaintenanceContext(updated);
}

/** BE-05 lifecycle governs binding eligibility: only ACTIVE assets bind. */
function assertOperationalAsset(status: string): void {
  if (status === 'RETIRED') {
    throw assetRetiredError();
  }
  if (status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Assets must be ACTIVE to receive maintenance bindings.',
    );
  }
}

/** Validates an optional BE-04 Functional Location refinement (BE-10 convention). */
async function assertMaintenanceLocation(
  functionalLocationId: string | null,
  assetBuildingId: string,
): Promise<string | null> {
  if (functionalLocationId === null) {
    return null;
  }
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }
  if (location.buildingId !== assetBuildingId) {
    throw maintenanceLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive functional locations cannot receive maintenance bindings.',
    );
  }
  return location.id;
}

/** Resolves a BE-07 schedule target (exists + belongs to the same client). */
async function resolveScheduleTarget(
  targetType: string,
  targetId: string,
  clientId: string,
): Promise<{ id: string; client_id: string; status: string } | null> {
  const table = SCHEDULE_TARGET_TABLES[targetType];
  if (!table) {
    return null;
  }
  const result = await getPool().query<{ id: string; client_id: string; status: string }>(
    `SELECT id, client_id, status FROM ${table} WHERE id = $1`,
    [targetId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  if (row.client_id !== clientId) {
    throw AppError.badRequest('Schedule target does not belong to the binding client.');
  }
  return row;
}

function assertActiveBinding(status: string): void {
  if (status !== 'ACTIVE') {
    throw maintenanceBindingInactiveError();
  }
}

async function requireBinding(
  id: string,
  userId: string,
): Promise<MaintenanceBindingRecord> {
  const record = await maintenanceBindingRepository.findById(id);
  if (!record) {
    throw maintenanceBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return record;
}

/** Projects the linked shared records' authoritative states into the context. */
async function resolveMaintenanceContext(
  record: MaintenanceBindingRecord,
): Promise<PublicMaintenanceBinding> {
  let schedule: ScheduleRow | null = null;
  if (record.scheduleDefinitionId) {
    schedule = await maintenanceBindingRepository.findSchedule(
      record.scheduleDefinitionId,
    );
  }
  let workOrder: WorkOrderRow | null = null;
  if (record.workOrderId) {
    workOrder = await maintenanceBindingRepository.findWorkOrder(record.workOrderId);
  }
  const tasks = await maintenanceBindingRepository.listBindingTasks(
    record.id,
    record.scheduleDefinitionId,
  );

  return toPublicMaintenanceBinding(record, schedule, workOrder, tasks);
}

export function toPublicMaintenanceBinding(
  record: MaintenanceBindingRecord,
  schedule: ScheduleRow | null,
  workOrder: WorkOrderRow | null,
  tasks: TaskRow[],
): PublicMaintenanceBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assetId: record.assetId,
    functionalLocationId: record.functionalLocationId,
    name: record.name,
    maintenanceType: record.maintenanceType,
    description: record.description,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    schedule: schedule
      ? {
          id: schedule.id,
          code: schedule.code,
          name: schedule.name,
          targetType: schedule.target_type,
          targetId: schedule.target_id,
          timezone: schedule.timezone,
          status: schedule.status,
        }
      : null,
    workOrder: workOrder
      ? {
          id: workOrder.id,
          workOrderNumber: workOrder.work_order_number,
          title: workOrder.title,
          status: workOrder.status,
        }
      : null,
    tasks: tasks.map((task) => ({
      id: task.id,
      occurrenceAt: task.occurrence_at.toISOString(),
      status: task.status,
    })),
  };
}

export const maintenanceBindingService = {
  createMaintenanceBinding,
  getMaintenanceBinding,
  linkMaintenanceSchedule,
  linkMaintenanceTask,
  linkMaintenanceWorkOrder,
  listMaintenanceBindingsByAsset,
  listMaintenanceBindingsByBuilding,
  updateMaintenanceBinding,
};
