import { engineeringReportRepository } from '../engineering-reports';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { securityFindingIncidentKpiRepository } from '../security-finding-incident-kpi';
import type { SecurityFindingIncidentKpiFilters } from '../security-finding-incident-kpi';
import { vendorTenantKpiRepository } from '../vendor-tenant-kpi';
import type { VendorTenantKpiFilters } from '../vendor-tenant-kpi';
import {
  workforceKpiDueBefore,
  workforceKpiRepository,
} from '../workforce-kpi';
import type { WorkforceKpiFilters } from '../workforce-kpi';
import type {
  ManagementDailyOperationsData,
  ManagementDailyOperationsQuery,
  PublicManagementDailyOperations,
} from './management-daily-operations.types';

const EMPTY_DATA: ManagementDailyOperationsData = {
  scheduled: 0,
  completed: 0,
  inProgress: 0,
  overdue: 0,
  openFindings: 0,
  criticalOperationalItems: {
    total: 0,
    securityIncidents: 0,
    tenantServiceRequests: 0,
  },
};

/**
 * BE-24 PART 02A — thin composition over existing reporting authorities.
 *
 * PART 01 resolves the complete authorized Building set first. The source
 * repositories then apply that set in SQL. No operational record is mutated,
 * no lifecycle is reinterpreted, and no BE-23 KPI formula is restated here.
 */
export async function getManagementDailyOperations(
  query: ManagementDailyOperationsQuery,
  userId: string,
): Promise<PublicManagementDailyOperations> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const buildingIds = context.scope.buildingIds;
  const modelFilters = {
    operationalDate: query.operationalDate,
    graceMinutes: query.graceMinutes,
  };

  if (buildingIds.length === 0) {
    return createManagementReadModelContract(
      context,
      modelFilters,
      cloneEmptyData(),
    );
  }

  const workforceFilters: WorkforceKpiFilters = {
    dateFrom: query.operationalDate,
    dateTo: query.operationalDate,
    graceMinutes: query.graceMinutes,
  };
  const securityFilters: SecurityFindingIncidentKpiFilters = {
    dateFrom: query.operationalDate,
    dateTo: query.operationalDate,
  };
  const vendorTenantFilters: VendorTenantKpiFilters = {
    dateFrom: query.operationalDate,
    dateTo: query.operationalDate,
  };
  const dueBefore = workforceKpiDueBefore(
    new Date(context.asOf),
    query.graceMinutes,
  );

  const [technicalRows, assignments, securityIncidents, tenantService] =
    await Promise.all([
      Promise.all(
        buildingIds.map((buildingId) =>
          engineeringReportRepository.getTechnicalSummary(
            {
              buildingId,
              dateFrom: query.operationalDate,
              dateTo: query.operationalDate,
            },
            range.start,
            range.end,
          ),
        ),
      ),
      workforceKpiRepository.getWorkforceAssignmentKpi(
        buildingIds,
        workforceFilters,
        range.start,
        range.end,
        dueBefore,
      ),
      securityFindingIncidentKpiRepository.getIncidentKpi(
        buildingIds,
        securityFilters,
        range.start,
        range.end,
      ),
      vendorTenantKpiRepository.getTenantServiceKpi(
        buildingIds,
        vendorTenantFilters,
        range.start,
        range.end,
      ),
    ]);

  const operations = technicalRows.reduce(
    (total, row) => {
      total.scheduled += row.scheduled_tasks;
      total.completed += row.completed_tasks;
      total.inProgress += row.in_progress_tasks;
      total.openFindings += row.open_findings;
      return total;
    },
    { scheduled: 0, completed: 0, inProgress: 0, openFindings: 0 },
  );

  const criticalSecurityIncidents = securityIncidents.severity_critical;
  const criticalTenantServiceRequests = tenantService.priority_critical;

  return createManagementReadModelContract(context, modelFilters, {
    ...operations,
    overdue: assignments.overdue,
    criticalOperationalItems: {
      total: criticalSecurityIncidents + criticalTenantServiceRequests,
      securityIncidents: criticalSecurityIncidents,
      tenantServiceRequests: criticalTenantServiceRequests,
    },
  });
}

function cloneEmptyData(): ManagementDailyOperationsData {
  return {
    ...EMPTY_DATA,
    criticalOperationalItems: { ...EMPTY_DATA.criticalOperationalItems },
  };
}

export const managementDailyOperationsService = {
  getManagementDailyOperations,
};
