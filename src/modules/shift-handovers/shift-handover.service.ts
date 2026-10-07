import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import { resolveAssetBuildingContext } from '../assets';
import { recordOperationalEvent } from '../operational-events';
import { shiftInactiveError, shiftNotFoundError } from '../shifts';
import {
  shiftHandoverImmutableError,
  shiftHandoverInvalidTransitionError,
  shiftHandoverNotFoundError,
  shiftHandoverSameShiftError,
  shiftHandoverShiftBuildingMismatchError,
} from './shift-handover.errors';
import {
  shiftHandoverRepository,
  type ShiftRow,
} from './shift-handover.repository';
import {
  type CreateShiftHandoverInput,
  type HandoverDataset,
  type PublicShiftHandover,
  type ShiftHandoverRecord,
  type UpdateShiftHandoverInput,
} from './shift-handover.types';

/**
 * BE-10J — Shift Handover service.
 *
 * Handovers reference BE-03 Shifts and resolve their operational content
 * live from the authoritative Engineering records. The summary is editable
 * only while DRAFT; READY locks the content and ACKNOWLEDGED is terminal.
 * Backend lifecycle rules: DRAFT → READY → ACKNOWLEDGED, no silent rewrites.
 */
export async function createShiftHandover(
  input: CreateShiftHandoverInput,
  userId: string,
): Promise<PublicShiftHandover> {
  const building = await buildingService.getBuildingById(input.buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);

  if (input.outgoingShiftId === input.incomingShiftId) {
    throw shiftHandoverSameShiftError();
  }
  const outgoingShift = await assertHandoverShift(
    input.outgoingShiftId,
    building.id,
  );
  const incomingShift = await assertHandoverShift(
    input.incomingShiftId,
    building.id,
  );

  const record = await shiftHandoverRepository.create({
    clientId: outgoingShift.client_id,
    buildingId: building.id,
    outgoingShiftId: outgoingShift.id,
    incomingShiftId: incomingShift.id,
    handoverDate: input.handoverDate,
    summary: input.summary ?? null,
    preparedByUserId: userId,
  });

  await recordOperationalEvent({
    clientId: record.clientId,
    eventType: 'SHIFT_HANDOVER_CREATED',
    entityType: 'SHIFT_HANDOVER',
    entityId: record.id,
    actorUserId: userId,
    buildingId: record.buildingId,
    summary: `Shift handover prepared from ${outgoingShift.code} to ${incomingShift.code}`,
    metadata: {
      outgoingShiftId: outgoingShift.id,
      incomingShiftId: incomingShift.id,
      handoverDate: input.handoverDate,
    },
  });

  return resolvePublicHandover(record, outgoingShift, incomingShift);
}

export async function getShiftHandover(
  id: string,
  userId: string,
): Promise<PublicShiftHandover> {
  const record = await requireHandover(id, userId);
  const [outgoingShift, incomingShift] = await Promise.all([
    shiftHandoverRepository.findShift(record.outgoingShiftId),
    shiftHandoverRepository.findShift(record.incomingShiftId),
  ]);
  return resolvePublicHandover(
    record,
    outgoingShift as ShiftRow,
    incomingShift as ShiftRow,
  );
}

export async function listShiftHandovers(
  buildingId: string,
  date: string | undefined,
  userId: string,
): Promise<PublicShiftHandover[]> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const records = await shiftHandoverRepository.listByBuilding(building.id, date);
  return Promise.all(
    records.map(async (record) => {
      const [outgoingShift, incomingShift] = await Promise.all([
        shiftHandoverRepository.findShift(record.outgoingShiftId),
        shiftHandoverRepository.findShift(record.incomingShiftId),
      ]);
      return resolvePublicHandover(
        record,
        outgoingShift as ShiftRow,
        incomingShift as ShiftRow,
      );
    }),
  );
}

/** Summary is editable only while DRAFT. */
export async function updateShiftHandoverSummary(
  id: string,
  input: UpdateShiftHandoverInput,
  userId: string,
): Promise<PublicShiftHandover> {
  const record = await requireHandover(id, userId);
  if (record.status !== 'DRAFT') {
    throw shiftHandoverImmutableError();
  }
  const updated = await shiftHandoverRepository.updateSummary(
    id,
    input.summary as string,
  );
  if (!updated) {
    throw shiftHandoverNotFoundError();
  }
  return getShiftHandover(id, userId);
}

/** DRAFT → READY. */
export async function markShiftHandoverReady(
  id: string,
  userId: string,
): Promise<PublicShiftHandover> {
  const record = await requireHandover(id, userId);
  if (record.status !== 'DRAFT') {
    throw shiftHandoverInvalidTransitionError();
  }
  const updated = await shiftHandoverRepository.markReady(id);
  if (!updated) {
    throw shiftHandoverNotFoundError();
  }
  await recordOperationalEvent({
    clientId: updated.clientId,
    eventType: 'SHIFT_HANDOVER_READY',
    entityType: 'SHIFT_HANDOVER',
    entityId: updated.id,
    actorUserId: userId,
    buildingId: updated.buildingId,
    summary: 'Shift handover marked ready',
    metadata: { handoverDate: updated.handoverDate },
  });
  return getShiftHandover(id, userId);
}

/** READY → ACKNOWLEDGED (actor is recorded; RBAC + building access enforced). */
export async function acknowledgeShiftHandover(
  id: string,
  userId: string,
): Promise<PublicShiftHandover> {
  const record = await requireHandover(id, userId);
  if (record.status !== 'READY') {
    throw shiftHandoverInvalidTransitionError();
  }
  const updated = await shiftHandoverRepository.acknowledge(id, userId);
  if (!updated) {
    throw shiftHandoverNotFoundError();
  }
  await recordOperationalEvent({
    clientId: updated.clientId,
    eventType: 'SHIFT_HANDOVER_ACKNOWLEDGED',
    entityType: 'SHIFT_HANDOVER',
    entityId: updated.id,
    actorUserId: userId,
    buildingId: updated.buildingId,
    summary: 'Shift handover acknowledged',
    metadata: { handoverDate: updated.handoverDate },
  });
  return getShiftHandover(id, userId);
}

/** Resolves the live Engineering operational dataset for the Building. */
async function resolveDataset(buildingId: string): Promise<HandoverDataset> {
  const [
    activeWorkOrders,
    openBreakdowns,
    openFindings,
    incompleteInspections,
    incompleteChecklists,
    incompleteMeterReadings,
    incompleteLogSheets,
    pendingMaintenance,
    scheduledTasks,
  ] = await Promise.all([
    shiftHandoverRepository.listActiveWorkOrders(buildingId),
    shiftHandoverRepository.listOpenBreakdowns(buildingId),
    shiftHandoverRepository.listOpenFindings(buildingId),
    shiftHandoverRepository.listIncompleteInspections(buildingId),
    shiftHandoverRepository.listIncompleteChecklists(buildingId),
    shiftHandoverRepository.listIncompleteMeterReadings(buildingId),
    shiftHandoverRepository.listIncompleteLogSheets(buildingId),
    shiftHandoverRepository.listPendingMaintenance(buildingId),
    shiftHandoverRepository.listScheduledTasks(buildingId),
  ]);
  return {
    activeWorkOrders,
    openBreakdowns,
    openFindings,
    incompleteInspections,
    incompleteChecklists,
    incompleteMeterReadings,
    incompleteLogSheets,
    pendingMaintenance,
    scheduledTasks,
  };
}

/** Both shifts must exist, be ACTIVE, and belong to the handover Building. */
async function assertHandoverShift(
  shiftId: string,
  buildingId: string,
): Promise<ShiftRow & { client_id: string }> {
  const shift = await shiftHandoverRepository.findShift(shiftId);
  if (!shift) {
    throw shiftNotFoundError();
  }
  if (shift.building_id !== buildingId) {
    throw shiftHandoverShiftBuildingMismatchError();
  }
  if (shift.status !== 'ACTIVE') {
    throw shiftInactiveError();
  }
  const { clientId } = await resolveAssetBuildingContext(shift.building_id);
  return { ...shift, client_id: clientId };
}

async function requireHandover(
  id: string,
  userId: string,
): Promise<ShiftHandoverRecord> {
  const record = await shiftHandoverRepository.findById(id);
  if (!record) {
    throw shiftHandoverNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return record;
}

async function resolvePublicHandover(
  record: ShiftHandoverRecord,
  outgoingShift: ShiftRow,
  incomingShift: ShiftRow,
): Promise<PublicShiftHandover> {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    outgoingShift: {
      id: outgoingShift.id,
      code: outgoingShift.code,
      name: outgoingShift.name,
      startTime: outgoingShift.start_time,
      endTime: outgoingShift.end_time,
    },
    incomingShift: {
      id: incomingShift.id,
      code: incomingShift.code,
      name: incomingShift.name,
      startTime: incomingShift.start_time,
      endTime: incomingShift.end_time,
    },
    handoverDate: record.handoverDate,
    preparedByUserId: record.preparedByUserId,
    acknowledgedByUserId: record.acknowledgedByUserId,
    summary: record.summary,
    status: record.status,
    preparedAt: record.preparedAt.toISOString(),
    acknowledgedAt: record.acknowledgedAt
      ? record.acknowledgedAt.toISOString()
      : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    dataset: await resolveDataset(record.buildingId),
  };
}

export const shiftHandoverService = {
  acknowledgeShiftHandover,
  createShiftHandover,
  getShiftHandover,
  listShiftHandovers,
  markShiftHandoverReady,
  updateShiftHandoverSummary,
};
