import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import {
  projectWorkforceKpiAssignments,
  projectWorkforceKpiHeadcount,
  projectWorkforceKpiManHours,
  workforceKpiDueBefore,
  workforceKpiRepository,
  type WorkforceKpiFilters,
} from '../workforce-kpi';
import {
  EMPTY_ASSIGNMENT_ROW,
  EMPTY_HEADCOUNT_ROW,
} from '../workforce-kpi/workforce-kpi.repository';
import { managementWorkforceSummaryRepository } from './management-workforce-summary.repository';
import type {
  ManagementWorkforceSummaryQuery,
  PublicManagementWorkforceSummary,
} from './management-workforce-summary.types';

/** BE-24 PART 04A — thin Management projection over BE-23G + BE-03 hierarchy. */
export async function getManagementWorkforceSummary(
  query: ManagementWorkforceSummaryQuery,
  userId: string,
): Promise<PublicManagementWorkforceSummary> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = { graceMinutes: query.graceMinutes };
  const buildingIds = context.scope.buildingIds;

  if (buildingIds.length === 0) {
    const headcount = projectWorkforceKpiHeadcount(EMPTY_HEADCOUNT_ROW, 0);
    const assignments = projectWorkforceKpiAssignments(EMPTY_ASSIGNMENT_ROW);
    return createManagementReadModelContract(context, filters, {
      totalWorkforce: headcount.total,
      activeWorkforce: headcount.active,
      assignedWorkforce: headcount.withAssignments,
      byDepartment: [],
      byTeam: [],
      assignments: {
        scheduled: assignments.scheduled,
        completed: assignments.completed,
        overdue: assignments.overdue,
      },
      manHours: projectWorkforceKpiManHours(EMPTY_ASSIGNMENT_ROW),
    });
  }

  const kpiFilters: WorkforceKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
    graceMinutes: query.graceMinutes,
  };
  const dueBefore = workforceKpiDueBefore(
    new Date(context.asOf),
    query.graceMinutes,
  );

  const [headcountRow, assignmentRow, hierarchy] = await Promise.all([
    workforceKpiRepository.getWorkforceHeadcount(buildingIds, kpiFilters),
    workforceKpiRepository.getWorkforceAssignmentKpi(
      buildingIds,
      kpiFilters,
      range.start,
      range.end,
      dueBefore,
    ),
    managementWorkforceSummaryRepository.getWorkforceHierarchyBreakdowns(
      buildingIds,
    ),
  ]);

  // All numeric KPI values below are projected by BE-23G's own helpers.
  const headcount = projectWorkforceKpiHeadcount(
    headcountRow,
    assignmentRow.distinct_workforce,
  );
  const assignments = projectWorkforceKpiAssignments(assignmentRow);

  return createManagementReadModelContract(context, filters, {
    totalWorkforce: headcount.total,
    activeWorkforce: headcount.active,
    assignedWorkforce: headcount.withAssignments,
    byDepartment: hierarchy.byDepartment,
    byTeam: hierarchy.byTeam,
    assignments: {
      scheduled: assignments.scheduled,
      completed: assignments.completed,
      overdue: assignments.overdue,
    },
    manHours: projectWorkforceKpiManHours(assignmentRow),
  });
}

export const managementWorkforceSummaryService = {
  getManagementWorkforceSummary,
};
