import { areaRepository } from '../areas';
import { buildingRepository } from '../buildings';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { floorRepository } from '../floors';
import { functionalLocationRepository } from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import {
  permitApplicationNotFoundError,
} from '../permit-applications/permit-application.errors';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import type { PermitApplicationRecord } from '../permit-applications/permit-application.types';
import { permitSafetyRequirementRepository } from '../permit-safety-requirements/permit-safety-requirement.repository';
import { permitNotFoundError } from '../permits/permit.errors';
import { permitRepository } from '../permits/permit.repository';
import { roomRepository } from '../rooms';
import {
  isValidWorkType,
  normalizeWorkType,
} from '../work-orders/work-order.validation';
import {
  permitWorkContextNotFoundError,
  permitWorkContextUpdateNotAllowedError,
  permitWorkLocationBuildingMismatchError,
  permitWorkLocationInvalidError,
  permitWorkPlannedPeriodInvalidError,
  permitWorkTypeInvalidError,
} from './permit-work-context.errors';
import { permitWorkContextRepository } from './permit-work-context.repository';
import type {
  AssignPermitWorkLocationInput,
  AssignPermitWorkTypeInput,
  PermitWorkContextFilters,
  PermitWorkContextRecord,
  PersistPermitWorkContext,
  PublicPermitWorkContext,
  ResolvedPermitWorkLocation,
  UpdatePermitWorkContextInput,
} from './permit-work-context.types';

export function toPublicPermitWorkContext(
  record: PermitWorkContextRecord,
): PublicPermitWorkContext {
  return {
    ...record,
    plannedStartAt: record.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: record.plannedEndAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function loadDraftApplication(
  permitApplicationId: string,
  actorUserId: string,
): Promise<PermitApplicationRecord> {
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (!application) throw permitApplicationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  if (application.status !== 'DRAFT') {
    throw permitWorkContextUpdateNotAllowedError();
  }
  return application;
}

function resolveWorkType(workType: string): string {
  const normalized = normalizeWorkType(workType);
  if (!isValidWorkType(normalized)) throw permitWorkTypeInvalidError();
  return normalized;
}

function assertPlannedPeriod(
  plannedStartAt: Date | null,
  plannedEndAt: Date | null,
): void {
  if (plannedStartAt === null && plannedEndAt === null) return;
  if (plannedStartAt === null || plannedEndAt === null) {
    throw permitWorkPlannedPeriodInvalidError();
  }
  const start = plannedStartAt.getTime();
  const end = plannedEndAt.getTime();
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start <= Date.now() ||
    end <= start
  ) {
    throw permitWorkPlannedPeriodInvalidError();
  }
}

async function resolveLocation(
  locationType: ResolvedPermitWorkLocation['locationType'],
  locationId: string,
  permitBuildingId: string,
): Promise<ResolvedPermitWorkLocation> {
  let actualBuildingId: string;
  const result: ResolvedPermitWorkLocation = {
    locationType,
    locationId,
    buildingLocationId: null,
    floorId: null,
    areaId: null,
    roomId: null,
    functionalLocationId: null,
  };

  if (locationType === 'BUILDING') {
    const building = await buildingRepository.findById(locationId);
    if (!building || building.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    actualBuildingId = building.id;
    result.buildingLocationId = building.id;
  } else if (locationType === 'FLOOR') {
    const floor = await floorRepository.findById(locationId);
    if (!floor || floor.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    actualBuildingId = floor.buildingId;
    result.floorId = floor.id;
  } else if (locationType === 'AREA') {
    const area = await areaRepository.findById(locationId);
    if (!area || area.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    const floor = await floorRepository.findById(area.floorId);
    if (!floor || floor.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    actualBuildingId = floor.buildingId;
    result.areaId = area.id;
  } else if (locationType === 'ROOM') {
    const room = await roomRepository.findById(locationId);
    if (!room || room.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    const area = await areaRepository.findById(room.areaId);
    if (!area || area.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    const floor = await floorRepository.findById(area.floorId);
    if (!floor || floor.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    actualBuildingId = floor.buildingId;
    result.roomId = room.id;
  } else {
    const functionalLocation = await functionalLocationRepository.findById(
      locationId,
    );
    if (!functionalLocation || functionalLocation.status !== 'ACTIVE') {
      throw permitWorkLocationInvalidError();
    }
    actualBuildingId = functionalLocation.buildingId;
    result.functionalLocationId = functionalLocation.id;
  }

  if (actualBuildingId !== permitBuildingId) {
    throw permitWorkLocationBuildingMismatchError();
  }
  return result;
}

function locationFromRecord(
  record: PermitWorkContextRecord | null,
): ResolvedPermitWorkLocation | null {
  if (!record?.locationType || !record.locationId) return null;
  return {
    locationType: record.locationType,
    locationId: record.locationId,
    buildingLocationId: record.buildingLocationId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    functionalLocationId: record.functionalLocationId,
  };
}

async function persist(
  input: PersistPermitWorkContext,
): Promise<PermitWorkContextRecord> {
  const saved = await permitWorkContextRepository.saveDraft(input);
  if (!saved) throw permitWorkContextUpdateNotAllowedError();
  return saved;
}

export async function assignPermitWorkLocation(
  permitApplicationId: string,
  input: AssignPermitWorkLocationInput,
  actorUserId: string,
): Promise<PublicPermitWorkContext> {
  const application = await loadDraftApplication(
    permitApplicationId,
    actorUserId,
  );
  assertPlannedPeriod(input.plannedStartAt, input.plannedEndAt);
  const location = await resolveLocation(
    input.locationType,
    input.locationId,
    application.buildingId,
  );
  const existing = await permitWorkContextRepository.findByApplicationId(
    application.id,
  );
  const saved = await persist({
    permitApplicationId: application.id,
    location,
    workType: existing?.workType ?? null,
    workDescription: input.workDescription === undefined
      ? existing?.workDescriptionOverride ?? null
      : input.workDescription,
    plannedStartAt: input.plannedStartAt,
    plannedEndAt: input.plannedEndAt,
    accessRestrictionNotes: input.accessRestrictionNotes === undefined
      ? existing?.accessRestrictionNotes ?? null
      : input.accessRestrictionNotes,
    actorUserId,
  });
  await recordWorkContextEvent(
    saved,
    actorUserId,
    'PERMIT_WORK_LOCATION_ASSIGNED',
    'Permit work location assigned',
  );
  return toPublicPermitWorkContext(saved);
}

export async function assignPermitWorkType(
  permitApplicationId: string,
  input: AssignPermitWorkTypeInput,
  actorUserId: string,
): Promise<PublicPermitWorkContext> {
  const workType = resolveWorkType(input.workType);
  const application = await loadDraftApplication(
    permitApplicationId,
    actorUserId,
  );
  const existing = await permitWorkContextRepository.findByApplicationId(
    application.id,
  );
  if (
    existing?.workType &&
    existing.workType !== workType &&
    await permitSafetyRequirementRepository.existsForApplication(application.id)
  ) {
    throw permitWorkContextUpdateNotAllowedError();
  }
  const saved = await persist({
    permitApplicationId: application.id,
    location: locationFromRecord(existing),
    workType,
    workDescription: input.workDescription === undefined
      ? existing?.workDescriptionOverride ?? null
      : input.workDescription,
    plannedStartAt: existing?.plannedStartAt ?? null,
    plannedEndAt: existing?.plannedEndAt ?? null,
    accessRestrictionNotes: existing?.accessRestrictionNotes ?? null,
    actorUserId,
  });
  await recordWorkContextEvent(
    saved,
    actorUserId,
    'PERMIT_WORK_TYPE_ASSIGNED',
    'Permit work type assigned',
  );
  return toPublicPermitWorkContext(saved);
}

export async function updatePermitWorkContext(
  permitApplicationId: string,
  input: UpdatePermitWorkContextInput,
  actorUserId: string,
): Promise<PublicPermitWorkContext> {
  const application = await loadDraftApplication(
    permitApplicationId,
    actorUserId,
  );
  const existing = await permitWorkContextRepository.findByApplicationId(
    application.id,
  );
  if (!existing) throw permitWorkContextNotFoundError();

  const location = input.locationType && input.locationId
    ? await resolveLocation(
        input.locationType,
        input.locationId,
        application.buildingId,
      )
    : locationFromRecord(existing);
  const workType = input.workType === undefined
    ? existing.workType
    : resolveWorkType(input.workType);
  if (
    input.workType !== undefined &&
    workType !== existing.workType &&
    await permitSafetyRequirementRepository.existsForApplication(application.id)
  ) {
    throw permitWorkContextUpdateNotAllowedError();
  }
  const plannedStartAt = input.plannedStartAt ?? existing.plannedStartAt;
  const plannedEndAt = input.plannedEndAt ?? existing.plannedEndAt;
  assertPlannedPeriod(plannedStartAt, plannedEndAt);

  const saved = await persist({
    permitApplicationId: application.id,
    location,
    workType,
    workDescription: input.workDescription === undefined
      ? existing.workDescriptionOverride
      : input.workDescription,
    plannedStartAt,
    plannedEndAt,
    accessRestrictionNotes: input.accessRestrictionNotes === undefined
      ? existing.accessRestrictionNotes
      : input.accessRestrictionNotes,
    actorUserId,
  });
  await recordWorkContextEvent(
    saved,
    actorUserId,
    'PERMIT_WORK_CONTEXT_UPDATED',
    'Permit work context updated',
  );
  return toPublicPermitWorkContext(saved);
}

export async function getApplicationWorkContext(
  permitApplicationId: string,
  actorUserId: string,
): Promise<PublicPermitWorkContext> {
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (!application) throw permitApplicationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  const context = await permitWorkContextRepository.findByApplicationId(
    application.id,
  );
  if (!context) throw permitWorkContextNotFoundError();
  return toPublicPermitWorkContext(context);
}

export async function getPermitWorkContext(
  permitId: string,
  actorUserId: string,
): Promise<PublicPermitWorkContext> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const context = await permitWorkContextRepository.findByPermitId(permit.id);
  if (!context) throw permitWorkContextNotFoundError();
  return toPublicPermitWorkContext(context);
}

export async function listPermitWorkContexts(
  filters: PermitWorkContextFilters,
  actorUserId: string,
): Promise<PublicPermitWorkContext[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await permitWorkContextRepository.list(filters, buildingIds)
  ).map(toPublicPermitWorkContext);
}

async function recordWorkContextEvent(
  context: PermitWorkContextRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
): Promise<void> {
  await recordOperationalEvent({
    clientId: context.clientId,
    buildingId: context.buildingId,
    entityType: 'PERMIT_WORK_CONTEXT',
    entityId: context.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      permitId: context.permitId,
      permitApplicationId: context.permitApplicationId,
      locationType: context.locationType,
      locationId: context.locationId,
      workType: context.workType,
      plannedStartAt: context.plannedStartAt?.toISOString() ?? null,
      plannedEndAt: context.plannedEndAt?.toISOString() ?? null,
    },
  });
}

export const permitWorkContextService = {
  assignPermitWorkLocation,
  assignPermitWorkType,
  getApplicationWorkContext,
  getPermitWorkContext,
  listPermitWorkContexts,
  toPublicPermitWorkContext,
  updatePermitWorkContext,
};
