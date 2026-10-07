import { managementWorkOrderSummaryRepository } from '../management-work-order-summary';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import {
  securityFindingIncidentKpiRepository,
  type SecurityFindingIncidentKpiFilters,
} from '../security-finding-incident-kpi';
import {
  vendorTenantKpiRepository,
  type VendorTenantKpiFilters,
} from '../vendor-tenant-kpi';
import {
  projectWorkforceKpiAssignments,
  workforceKpiDueBefore,
  workforceKpiRepository,
  type WorkforceKpiFilters,
} from '../workforce-kpi';
import { managementOperationalKpiRepository } from './management-operational-kpi.repository';
import type {
  ManagementOperationalKpiQuery,
  PublicManagementOperationalKpi,
} from './management-operational-kpi.types';

/** BE-24 PART 07 — thin KPI composition over established reporting values. */
export async function getManagementOperationalKpi(
  query: ManagementOperationalKpiQuery,
  userId: string,
): Promise<PublicManagementOperationalKpi> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = { graceMinutes: query.graceMinutes };
  const buildingIds = context.scope.buildingIds;

  if (buildingIds.length === 0) {
    return createManagementReadModelContract(context, filters, emptyKpi());
  }

  const workforceFilters: WorkforceKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
    graceMinutes: query.graceMinutes,
  };
  const securityFilters: SecurityFindingIncidentKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
  };
  const tenantFilters: VendorTenantKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
  };
  const dueBefore = workforceKpiDueBefore(
    new Date(context.asOf),
    query.graceMinutes,
  );

  const [assignmentRow, workOrders, sources, security, tenant] =
    await Promise.all([
      workforceKpiRepository.getWorkforceAssignmentKpi(
        buildingIds,
        workforceFilters,
        range.start,
        range.end,
        dueBefore,
      ),
      managementWorkOrderSummaryRepository.getWorkOrderSummary(
        buildingIds,
        range.start,
        range.end,
        dueBefore,
      ),
      managementOperationalKpiRepository.getOperationalSourceCounts(
        buildingIds,
        range.start,
        range.end,
      ),
      securityFindingIncidentKpiRepository.getIncidentKpi(
        buildingIds,
        securityFilters,
        range.start,
        range.end,
      ),
      vendorTenantKpiRepository.getTenantServiceKpi(
        buildingIds,
        tenantFilters,
        range.start,
        range.end,
      ),
    ]);
  const assignments = projectWorkforceKpiAssignments(assignmentRow);
  const criticalSecurityIncidents = security.severity_critical;
  const criticalTenantRequests = tenant.priority_critical;

  return createManagementReadModelContract(context, filters, {
    scheduled: assignments.scheduled,
    completed: assignments.completed,
    completionRate: assignments.completionRate,
    overdue: assignments.overdue,
    overdueRate: workforceKpiRepository.completionRate(
      assignments.overdue,
      assignments.scheduled,
    ),
    workOrders: { open: workOrders.open, closed: workOrders.closed },
    findings: {
      open: sources.open_findings,
      closed: sources.closed_findings,
    },
    incidentCount: sources.incident_count,
    criticalOperationalItems: {
      total: criticalSecurityIncidents + criticalTenantRequests,
      securityIncidents: criticalSecurityIncidents,
      tenantServiceRequests: criticalTenantRequests,
    },
  });
}

function emptyKpi() {
  return {
    scheduled: 0,
    completed: 0,
    completionRate: 0,
    overdue: 0,
    overdueRate: 0,
    workOrders: { open: 0, closed: 0 },
    findings: { open: 0, closed: 0 },
    incidentCount: 0,
    criticalOperationalItems: {
      total: 0,
      securityIncidents: 0,
      tenantServiceRequests: 0,
    },
  };
}

export const managementOperationalKpiService = {
  getManagementOperationalKpi,
};
