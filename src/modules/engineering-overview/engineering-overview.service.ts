import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  engineeringDailyOperationsRepository,
  engineeringDailyOperationsService,
  operationalDayWindow,
} from '../engineering-daily-operations';
import { shiftHandoverRepository } from '../shift-handovers';
import type { HandoverItem } from '../shift-handovers/shift-handover.types';
import { engineeringOverviewRepository } from './engineering-overview.repository';
import type {
  OverviewFindingCounts,
  OverviewWorkOrderCounts,
  PublicEngineeringOverview,
} from './engineering-overview.types';
import type { OverviewQuery } from './engineering-overview.validation';

/**
 * BE-10K — Engineering Aggregation service.
 *
 * Composes the authoritative BE-10A daily operations (which already carries
 * the date/shift context and isolation), BE-10I-style single-statement
 * aggregates, and the BE-10J handover dataset into one concise overview.
 * No business logic is duplicated — every section comes from the source
 * services/tables.
 */
export async function getEngineeringOverview(
  buildingId: string,
  query: OverviewQuery,
  userId: string,
): Promise<PublicEngineeringOverview> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);

  // BE-10A: authoritative daily operations + shift validation + isolation.
  const daily = await engineeringDailyOperationsService.getDailyEngineeringOperations(
    { buildingId: building.id, operationalDate: query.date, shiftId: query.shiftId },
    userId,
  );

  const { start, end } = operationalDayWindow(query.date);

  let shiftWorkforceIds: string[] | null = null;
  if (query.shiftId) {
    const workforce = await engineeringDailyOperationsRepository.listShiftWorkforce(
      query.shiftId,
      start,
      end,
    );
    shiftWorkforceIds = workforce.map((row) => row.workforce_profile_id);
  }

  const [findingCounts, workOrderCounts, activeWorkOrders, handoverCounts] =
    await Promise.all([
      engineeringOverviewRepository.getFindingCounts(
        building.id,
        start,
        end,
        shiftWorkforceIds,
      ),
      engineeringOverviewRepository.getWorkOrderCounts(
        building.id,
        start,
        end,
        shiftWorkforceIds,
      ),
      engineeringOverviewRepository.listActiveWorkOrders(
        building.id,
        start,
        end,
        shiftWorkforceIds,
      ),
      engineeringOverviewRepository.getHandoverCounts(building.id, query.date),
    ]);

  const pendingItems = await resolvePendingHandoverItems(building.id);

  return {
    buildingId: building.id,
    date: query.date,
    shift: daily.shift,
    summary: {
      scheduledOperations: daily.summary.scheduled,
      inProgressOperations: daily.summary.inProgress,
      completedOperations: daily.summary.completed,
      activeWorkOrders: workOrderCounts.active,
      openFindings: findingCounts.open,
      pendingHandoverItems: pendingItems.length,
    },
    operations: daily.summary,
    findings: findingCounts,
    workOrders: {
      active: activeWorkOrders,
      completedInWindow: workOrderCounts.completedInWindow,
    },
    handover: {
      drafts: handoverCounts.drafts,
      ready: handoverCounts.ready,
      acknowledged: handoverCounts.acknowledged,
      pendingItems,
    },
  };
}

/** Reuses BE-10J's authoritative unresolved-item dataset (no new logic). */
async function resolvePendingHandoverItems(
  buildingId: string,
): Promise<HandoverItem[]> {
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

  return [
    ...activeWorkOrders,
    ...openBreakdowns,
    ...openFindings,
    ...incompleteInspections,
    ...incompleteChecklists,
    ...incompleteMeterReadings,
    ...incompleteLogSheets,
    ...pendingMaintenance,
    ...scheduledTasks,
  ].slice(0, 100);
}

export const engineeringOverviewService = {
  getEngineeringOverview,
};
