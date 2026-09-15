import { contextAccessService } from '../context-access';
import { findingActionService } from '../findings';
import { shiftInactiveError, shiftService } from '../shifts';
import { buildingService } from '../buildings';
import { engineeringShiftBuildingMismatchError } from './engineering-daily-operations.errors';
import {
  engineeringDailyOperationsRepository,
  type DailyFindingRow,
  type DailyTaskRow,
  type DailyWorkOrderRow,
  type ShiftWorkforceRow,
} from './engineering-daily-operations.repository';
import {
  ACTIVE_WORK_ORDER_STATUSES,
  IN_PROGRESS_WORK_ORDER_STATUSES,
  OPEN_FINDING_STATUSES,
  SCHEDULED_TASK_STATUSES,
  type DailyOperationsQuery,
  type DailyOperationsSummary,
  type PublicDailyEngineeringOperations,
  type PublicDailyOperation,
  type PublicShiftContext,
} from './engineering-daily-operations.types';

/**
 * BE-10A — Daily Engineering Operations service.
 *
 * A read-only consolidated daily operational view derived exclusively from the
 * authoritative BE-04/05/07/08/09 records. No new operational table, no
 * duplicated workflow rules, no copied records.
 *
 * Operational-day windows are UTC: the BE-07 scheduler generates occurrences
 * from `YYYY-MM-DDT00:00:00Z` recurrence dates, so the day boundary follows
 * the scheduler's own authoritative convention.
 *
 * Workflow actions are never determined here — for Findings the existing
 * BE-09 `findingActionService.resolveAvailableActions` is reused verbatim.
 */
export async function getDailyEngineeringOperations(
  query: DailyOperationsQuery,
  userId: string,
): Promise<PublicDailyEngineeringOperations> {
  const building = await buildingService.getBuildingById(query.buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);

  const { start, end } = operationalDayWindow(query.operationalDate);

  let shiftContext: PublicShiftContext | null = null;
  let shiftWorkforceIds: string[] | null = null;
  if (query.shiftId) {
    const shift = await shiftService.getShiftById(query.shiftId);
    if (shift.buildingId !== building.id) {
      throw engineeringShiftBuildingMismatchError();
    }
    if (shift.status !== 'ACTIVE') {
      throw shiftInactiveError();
    }
    const workforce = await engineeringDailyOperationsRepository.listShiftWorkforce(
      shift.id,
      start,
      end,
    );
    shiftWorkforceIds = workforce.map((row) => row.workforce_profile_id);
    shiftContext = toPublicShiftContext(shift.id, shift.code, shift.name, shift.startTime, shift.endTime, shift.status, workforce);
  }

  const [tasks, workOrders, findings] = await Promise.all([
    engineeringDailyOperationsRepository.listDailyTasks(
      building.id,
      start,
      end,
      shiftWorkforceIds,
    ),
    engineeringDailyOperationsRepository.listDailyWorkOrders(
      building.id,
      start,
      end,
      shiftWorkforceIds,
    ),
    engineeringDailyOperationsRepository.listDailyFindings(
      building.id,
      start,
      end,
      shiftWorkforceIds,
    ),
  ]);

  const operations: PublicDailyOperation[] = [];
  const summary: DailyOperationsSummary = {
    scheduled: 0,
    inProgress: 0,
    completed: 0,
    openWorkOrders: 0,
    openFindings: 0,
  };

  for (const task of tasks) {
    const operation = toPublicTaskOperation(task);
    if ((SCHEDULED_TASK_STATUSES as readonly string[]).includes(task.status)) {
      summary.scheduled += 1;
    }
    if (task.status === 'IN_PROGRESS') {
      summary.inProgress += 1;
    }
    if (task.status === 'COMPLETED') {
      summary.completed += 1;
    }
    operations.push(operation);
  }

  for (const workOrder of workOrders) {
    const operation = toPublicWorkOrderOperation(workOrder);
    if (
      (ACTIVE_WORK_ORDER_STATUSES as readonly string[]).includes(
        workOrder.status,
      )
    ) {
      summary.openWorkOrders += 1;
    }
    if (
      (IN_PROGRESS_WORK_ORDER_STATUSES as readonly string[]).includes(
        workOrder.status,
      )
    ) {
      summary.inProgress += 1;
    }
    if (workOrder.status === 'COMPLETED' || workOrder.status === 'CLOSED') {
      summary.completed += 1;
    }
    operations.push(operation);
  }

  for (const finding of findings) {
    const operation = toPublicFindingOperation(finding);
    if ((OPEN_FINDING_STATUSES as readonly string[]).includes(finding.status)) {
      summary.openFindings += 1;
    }
    if (finding.status === 'VERIFIED' || finding.status === 'CLOSED') {
      summary.completed += 1;
    }
    // BE-09 backend authority — never re-derived, never frontend-owned.
    const actions = await findingActionService.resolveAvailableActions(
      finding.id,
      { userId },
    );
    operations.push({ ...operation, availableActions: actions.availableActions });
  }

  operations.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );

  return {
    buildingId: building.id,
    operationalDate: query.operationalDate,
    shift: shiftContext,
    summary,
    operations,
  };
}

/**
 * `YYYY-MM-DD` → UTC day window. Matches the BE-07 scheduler convention:
 * occurrences are generated from UTC-midnight recurrence dates.
 */
export function operationalDayWindow(
  operationalDate: string,
): { start: Date; end: Date } {
  const [year, month, day] = operationalDate.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function toPublicShiftContext(
  id: string,
  code: string,
  name: string,
  startTime: string,
  endTime: string,
  status: string,
  workforce: ShiftWorkforceRow[],
): PublicShiftContext {
  return {
    id,
    code,
    name,
    startTime,
    endTime,
    status,
    workforceCount: workforce.length,
    workforce: workforce.map((row) => ({
      workforceProfileId: row.workforce_profile_id,
      employeeCode: row.employee_code,
      fullName: row.full_name,
    })),
  };
}

function toPublicTaskOperation(task: DailyTaskRow): PublicDailyOperation {
  return {
    kind: 'TASK',
    id: task.id,
    referenceNumber: task.schedule_code,
    title: task.schedule_name ?? `Task ${task.target_type.toLowerCase()}`,
    status: task.status,
    occurredAt: task.occurrence_at.toISOString(),
    completedAt: task.completed_at ? task.completed_at.toISOString() : null,
    assignee: task.assignee_type
      ? {
          type: task.assignee_type,
          workforceProfileId: task.workforce_profile_id,
          teamId: task.team_id,
          vendorId: null,
        }
      : null,
  };
}

function toPublicWorkOrderOperation(
  workOrder: DailyWorkOrderRow,
): PublicDailyOperation {
  return {
    kind: 'WORK_ORDER',
    id: workOrder.id,
    referenceNumber: workOrder.work_order_number,
    title: workOrder.title,
    status: workOrder.status,
    occurredAt: workOrder.created_at.toISOString(),
    completedAt:
      workOrder.status === 'CLOSED' && workOrder.closed_at
        ? workOrder.closed_at.toISOString()
        : workOrder.completed_at
          ? workOrder.completed_at.toISOString()
          : null,
    assignee: workOrder.assignee_type
      ? {
          type: workOrder.assignee_type,
          workforceProfileId: workOrder.workforce_profile_id,
          teamId: workOrder.team_id,
          vendorId: workOrder.vendor_id,
        }
      : null,
  };
}

function toPublicFindingOperation(finding: DailyFindingRow): PublicDailyOperation {
  const completed =
    finding.status === 'VERIFIED' || finding.status === 'CLOSED';
  return {
    kind: 'FINDING',
    id: finding.id,
    referenceNumber: finding.finding_number,
    title: finding.title,
    status: finding.status,
    occurredAt: finding.reported_at.toISOString(),
    completedAt: completed ? finding.state_changed_at.toISOString() : null,
    assignee: finding.assignee_type
      ? {
          type: finding.assignee_type,
          workforceProfileId: finding.workforce_profile_id,
          teamId: finding.team_id,
          vendorId: finding.vendor_id,
        }
      : null,
  };
}

export const engineeringDailyOperationsService = {
  getDailyEngineeringOperations,
};
