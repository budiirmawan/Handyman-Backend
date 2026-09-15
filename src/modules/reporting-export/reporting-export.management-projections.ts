import type { PublicManagementOperationsCommandCenter } from '../management-operations-command-center';
import type {
  ReportingExportColumn,
  ReportingExportKpiValue,
  ReportingExportTable,
} from './reporting-export.types';

/**
 * BE-24 PART 10 — neutral export projection for the Operations Command Center.
 * Every value is copied from the completed BE-24 facade. This file performs no
 * sum, rate, threshold, monetary rollup, or other domain/KPI calculation.
 */

const NUMBER = 'NUMBER' as const;
const PERCENT = 'PERCENT' as const;
const STRING = 'STRING' as const;
const DATE = 'DATE' as const;
const BOOLEAN = 'BOOLEAN' as const;

function kpi(
  key: string,
  label: string,
  value: number | string | null,
  type: ReportingExportKpiValue['type'] = NUMBER,
): ReportingExportKpiValue {
  return { key, label, value, type };
}

function table(
  key: string,
  label: string,
  columns: ReportingExportColumn[],
  rows: ReportingExportTable['rows'],
): ReportingExportTable {
  return { key, label, columns, rows, rowCount: rows.length };
}

export function projectManagementOperationsCommandCenter(
  source: PublicManagementOperationsCommandCenter,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const data = source.data;
  const daily = data.dailyOperations;
  const workOrders = data.workOrderSummary;
  const workforce = data.workforceSummary;
  const vendor = data.vendorSummary;
  const tenant = data.tenantServiceSummary;
  const registry = data.assetEngineeringHealth.assetRegistryCompliance;
  const reliability = data.assetEngineeringHealth.assetReliabilityWork;
  const utility = data.utilitySummary;
  const operational = data.operationalKpi;
  const portfolio = data.portfolioContext;

  return {
    kpis: [
      kpi('dailyScheduled', 'Daily Scheduled', daily.scheduled),
      kpi('dailyCompleted', 'Daily Completed', daily.completed),
      kpi('dailyInProgress', 'Daily In Progress', daily.inProgress),
      kpi('dailyOverdue', 'Daily Overdue', daily.overdue),
      kpi('dailyOpenFindings', 'Daily Open Findings', daily.openFindings),
      kpi(
        'dailyCriticalOperationalItems',
        'Daily Critical Operational Items',
        daily.criticalOperationalItems.total,
      ),
      kpi(
        'pendingApprovalCount',
        'Pending Approvals',
        data.pendingApprovals.pendingCount,
      ),
      kpi(
        'criticalFindingCount',
        'Critical Findings',
        data.criticalFindings.criticalFindingCount,
      ),
      kpi('workOrdersTotal', 'Work Orders Total', workOrders.total),
      kpi('workOrdersOpen', 'Work Orders Open', workOrders.open),
      kpi('workOrdersInProgress', 'Work Orders In Progress', workOrders.inProgress),
      kpi('workOrdersCompleted', 'Work Orders Completed', workOrders.completed),
      kpi('workOrdersOverdue', 'Work Orders Overdue', workOrders.overdue),
      kpi('workOrdersVerified', 'Work Orders Verified', workOrders.verified),
      kpi('workOrdersClosed', 'Work Orders Closed', workOrders.closed),
      kpi('workforceTotal', 'Workforce Total', workforce.totalWorkforce),
      kpi('workforceActive', 'Workforce Active', workforce.activeWorkforce),
      kpi('workforceAssigned', 'Workforce Assigned', workforce.assignedWorkforce),
      kpi(
        'workforceAssignmentsScheduled',
        'Workforce Assignments Scheduled',
        workforce.assignments.scheduled,
      ),
      kpi(
        'workforceAssignmentsCompleted',
        'Workforce Assignments Completed',
        workforce.assignments.completed,
      ),
      kpi(
        'workforceAssignmentsOverdue',
        'Workforce Assignments Overdue',
        workforce.assignments.overdue,
      ),
      kpi('workforceManHours', 'Workforce Man-Hours', workforce.manHours.totalHours),
      kpi('activeVendors', 'Active Vendors', vendor.activeVendors),
      kpi('vendorWorkAssigned', 'Vendor Work Assigned', vendor.assignedVendorWork),
      kpi('vendorWorkCompleted', 'Vendor Work Completed', vendor.completedVendorWork),
      kpi('vendorWorkOverdue', 'Vendor Work Overdue', vendor.overdueVendorWork),
      kpi(
        'vendorCompletionRate',
        'Vendor Completion Rate',
        vendor.completionRate,
        PERCENT,
      ),
      kpi('tenantRequestsTotal', 'Tenant Requests Total', tenant.totalRequests),
      kpi('tenantRequestsOpen', 'Tenant Requests Open', tenant.openRequests),
      kpi(
        'tenantRequestsInProgress',
        'Tenant Requests In Progress',
        tenant.inProgressRequests,
      ),
      kpi(
        'tenantRequestsCompleted',
        'Tenant Requests Completed',
        tenant.completedRequests,
      ),
      kpi('tenantRequestsOverdue', 'Tenant Requests Overdue', tenant.overdueRequests),
      kpi(
        'tenantCompletionRate',
        'Tenant Completion Rate',
        tenant.completionRate,
        PERCENT,
      ),
      kpi('assetsTotal', 'Assets Total', registry.totalAssets),
      kpi('assetsActive', 'Assets Active', registry.activeAssets),
      kpi(
        'assetAvailabilityRate',
        'Asset Availability Rate',
        reliability.assetAvailability.availabilityRate,
        PERCENT,
      ),
      kpi('breakdownsTotal', 'Breakdowns Total', reliability.breakdowns.total),
      kpi('breakdownsOpen', 'Breakdowns Open', reliability.breakdowns.open),
      kpi('assetFailuresTotal', 'Asset Failures Total', reliability.failures.total),
      kpi('assetFailuresOpen', 'Asset Failures Open', reliability.failures.open),
      kpi('pmScheduled', 'PM Scheduled', reliability.pmCompliance.scheduled),
      kpi('pmCompleted', 'PM Completed', reliability.pmCompliance.completed),
      kpi('pmOverdue', 'PM Overdue', reliability.pmCompliance.overdue),
      kpi(
        'pmComplianceRate',
        'PM Compliance Rate',
        reliability.pmCompliance.complianceRate,
        PERCENT,
      ),
      kpi(
        'expiredComplianceCount',
        'Expired Compliance Records',
        registry.certifications.expiredComplianceCount,
      ),
      kpi(
        'expiringComplianceCount',
        'Expiring Compliance Records',
        registry.certifications.expiringComplianceCount,
      ),
      kpi(
        'electricityConsumption',
        'Electricity Consumption',
        utility.electricity.totalConsumption,
      ),
      kpi('waterConsumption', 'Water Consumption', utility.water.totalConsumption),
      kpi('gasConsumption', 'Gas Consumption', utility.gas.totalConsumption),
      kpi(
        'abnormalConsumption',
        'Abnormal Consumption Records',
        utility.abnormalConsumption.total,
      ),
      kpi(
        'verifiedReadings',
        'Verified Readings',
        utility.verifiedReadingSummary.verified,
      ),
      kpi(
        'operationalCompletionRate',
        'Operational Completion Rate',
        operational.completionRate,
        PERCENT,
      ),
      kpi(
        'operationalOverdueRate',
        'Operational Overdue Rate',
        operational.overdueRate,
        PERCENT,
      ),
      kpi('operationalIncidents', 'Operational Incidents', operational.incidentCount),
      kpi('portfolioBuildingCount', 'Portfolio Building Count', portfolio.buildingCount),
      kpi(
        'portfolioCompletionRate',
        'Portfolio Completion Rate',
        portfolio.operational.completionRate,
        PERCENT,
      ),
      kpi(
        'portfolioOverdueRate',
        'Portfolio Overdue Rate',
        portfolio.operational.overdueRate,
        PERCENT,
      ),
    ],
    tables: [
      pendingApprovalTable(source),
      criticalFindingTable(source),
      vendorPerformanceTable(source),
      clientFinancialTable(source),
      buildingPerformanceTable(source),
    ],
  };
}

function pendingApprovalTable(
  source: PublicManagementOperationsCommandCenter,
): ReportingExportTable {
  return table(
    'pendingApprovals',
    'Pending Approvals',
    [
      { key: 'approvalId', label: 'Approval Id', type: STRING },
      { key: 'clientId', label: 'Client Id', type: STRING },
      { key: 'buildingId', label: 'Building Id', type: STRING },
      { key: 'source', label: 'Source', type: STRING },
      { key: 'approvalType', label: 'Approval Type', type: STRING },
      { key: 'resourceType', label: 'Resource Type', type: STRING },
      { key: 'resourceId', label: 'Resource Id', type: STRING },
      { key: 'resourceReference', label: 'Resource Reference', type: STRING },
      { key: 'submittedAt', label: 'Submitted At', type: DATE },
      { key: 'currentStatus', label: 'Current Status', type: STRING },
      { key: 'availableActions', label: 'Available Actions', type: STRING },
    ],
    source.data.pendingApprovals.items.map((item) => ({
      approvalId: item.approvalId,
      clientId: item.clientId,
      buildingId: item.buildingId,
      source: item.source,
      approvalType: item.approvalType,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      resourceReference: item.resourceReference,
      submittedAt: item.submittedAt,
      currentStatus: item.currentStatus,
      availableActions: item.availableActions.join(','),
    })),
  );
}

function criticalFindingTable(
  source: PublicManagementOperationsCommandCenter,
): ReportingExportTable {
  return table(
    'criticalFindings',
    'Critical Findings',
    [
      { key: 'findingId', label: 'Finding Id', type: STRING },
      { key: 'clientId', label: 'Client Id', type: STRING },
      { key: 'buildingId', label: 'Building Id', type: STRING },
      { key: 'findingReference', label: 'Finding Reference', type: STRING },
      { key: 'title', label: 'Title', type: STRING },
      { key: 'severityCode', label: 'Severity Code', type: STRING },
      { key: 'severityName', label: 'Severity Name', type: STRING },
      { key: 'severityRank', label: 'Severity Rank', type: NUMBER },
      { key: 'contextType', label: 'Context Type', type: STRING },
      { key: 'status', label: 'Status', type: STRING },
      { key: 'responsiblePartyType', label: 'Responsible Party Type', type: STRING },
      { key: 'reportedAt', label: 'Reported At', type: DATE },
      { key: 'overdue', label: 'Overdue', type: BOOLEAN },
    ],
    source.data.criticalFindings.items.map((item) => ({
      findingId: item.findingId,
      clientId: item.clientId,
      buildingId: item.buildingId,
      findingReference: item.findingReference,
      title: item.title,
      severityCode: item.severity.code,
      severityName: item.severity.name,
      severityRank: item.severity.rank,
      contextType: item.context.type,
      status: item.status,
      responsiblePartyType: item.responsibleParty?.type ?? null,
      reportedAt: item.reportedAt,
      overdue: item.overdue,
    })),
  );
}

function vendorPerformanceTable(
  source: PublicManagementOperationsCommandCenter,
): ReportingExportTable {
  return table(
    'vendorPerformance',
    'Vendor Performance',
    [
      { key: 'vendorId', label: 'Vendor Id', type: STRING },
      { key: 'vendorCode', label: 'Vendor Code', type: STRING },
      { key: 'vendorName', label: 'Vendor Name', type: STRING },
      { key: 'vendorStatus', label: 'Vendor Status', type: STRING },
      { key: 'total', label: 'Total Work', type: NUMBER },
      { key: 'completed', label: 'Completed', type: NUMBER },
      { key: 'outstanding', label: 'Outstanding', type: NUMBER },
      { key: 'overdue', label: 'Overdue', type: NUMBER },
      { key: 'completionRate', label: 'Completion Rate', type: PERCENT },
      {
        key: 'averageCompletionHours',
        label: 'Average Completion Hours',
        type: NUMBER,
      },
    ],
    source.data.vendorSummary.vendorPerformance.map((row) => ({ ...row })),
  );
}

function clientFinancialTable(
  source: PublicManagementOperationsCommandCenter,
): ReportingExportTable {
  return table(
    'clientFinancialSummary',
    'Client Financial Summary',
    [
      { key: 'clientId', label: 'Client Id', type: STRING },
      { key: 'buildingIds', label: 'Building Ids', type: STRING },
      { key: 'tenantChargeAmount', label: 'Tenant Charges', type: NUMBER },
      { key: 'utilityBillAmount', label: 'Utility Bills', type: NUMBER },
      { key: 'invoiceAmount', label: 'Invoices', type: NUMBER },
      { key: 'paidAmount', label: 'Paid Amount', type: NUMBER },
      { key: 'unpaidAmount', label: 'Unpaid Amount', type: NUMBER },
      { key: 'overdueAmount', label: 'Overdue Amount', type: NUMBER },
      { key: 'outstandingAmount', label: 'Outstanding Amount', type: NUMBER },
      { key: 'receiptAmount', label: 'Issued Receipts', type: NUMBER },
      { key: 'vendorServiceCost', label: 'Vendor Service Cost', type: NUMBER },
      { key: 'basicExpense', label: 'Basic Expense', type: NUMBER },
      { key: 'outstandingBalance', label: 'Outstanding Balance', type: NUMBER },
      { key: 'billedIncome', label: 'Billed Income', type: NUMBER },
      { key: 'receivedIncome', label: 'Received Income', type: NUMBER },
      { key: 'operationalCost', label: 'Operational Cost', type: NUMBER },
      { key: 'netBilled', label: 'Net Billed', type: NUMBER },
      { key: 'netReceived', label: 'Net Received', type: NUMBER },
    ],
    source.data.financialSummary.clientSummaries.map((client) => ({
      clientId: client.clientId,
      buildingIds: client.buildingIds.join(','),
      tenantChargeAmount: client.summary.tenantCharges.amount,
      utilityBillAmount: client.summary.utilityBills.amount,
      invoiceAmount: client.summary.invoices.amount,
      paidAmount: client.summary.payments.paidAmount,
      unpaidAmount: client.summary.payments.unpaidAmount,
      overdueAmount: client.summary.payments.overdueAmount,
      outstandingAmount: client.summary.payments.outstandingAmount,
      receiptAmount: client.summary.receipts.issued.amount,
      vendorServiceCost: client.summary.vendorServiceCosts.finalized.amount,
      basicExpense: client.summary.basicExpenses.finalized.amount,
      outstandingBalance: client.summary.outstandingBalance.amount,
      billedIncome: client.summary.incomeVsOperationalCost.billedIncome,
      receivedIncome: client.summary.incomeVsOperationalCost.receivedIncome,
      operationalCost: client.summary.incomeVsOperationalCost.operationalCost,
      netBilled: client.summary.incomeVsOperationalCost.netBilled,
      netReceived: client.summary.incomeVsOperationalCost.netReceived,
    })),
  );
}

function buildingPerformanceTable(
  source: PublicManagementOperationsCommandCenter,
): ReportingExportTable {
  return table(
    'buildingPerformance',
    'Building Performance',
    [
      { key: 'buildingId', label: 'Building Id', type: STRING },
      { key: 'completionRate', label: 'Completion Rate', type: PERCENT },
      { key: 'overdueRate', label: 'Overdue Rate', type: PERCENT },
      { key: 'workOrdersTotal', label: 'Work Orders Total', type: NUMBER },
      { key: 'workOrdersOpen', label: 'Work Orders Open', type: NUMBER },
      { key: 'workOrdersCompleted', label: 'Work Orders Completed', type: NUMBER },
      { key: 'workOrdersOverdue', label: 'Work Orders Overdue', type: NUMBER },
      { key: 'findingsOpen', label: 'Findings Open', type: NUMBER },
      { key: 'findingsClosed', label: 'Findings Closed', type: NUMBER },
      { key: 'criticalFindings', label: 'Critical Findings', type: NUMBER },
      { key: 'assetsTotal', label: 'Assets Total', type: NUMBER },
      { key: 'assetsActive', label: 'Assets Active', type: NUMBER },
      { key: 'assetAvailabilityRate', label: 'Asset Availability Rate', type: PERCENT },
      { key: 'pmComplianceRate', label: 'PM Compliance Rate', type: PERCENT },
      { key: 'electricityConsumption', label: 'Electricity Consumption', type: NUMBER },
      { key: 'waterConsumption', label: 'Water Consumption', type: NUMBER },
      { key: 'gasConsumption', label: 'Gas Consumption', type: NUMBER },
      { key: 'tenantRequestsTotal', label: 'Tenant Requests Total', type: NUMBER },
      { key: 'tenantRequestsOpen', label: 'Tenant Requests Open', type: NUMBER },
      { key: 'tenantRequestsCompleted', label: 'Tenant Requests Completed', type: NUMBER },
      { key: 'tenantRequestsOverdue', label: 'Tenant Requests Overdue', type: NUMBER },
      { key: 'tenantCompletionRate', label: 'Tenant Completion Rate', type: PERCENT },
    ],
    source.data.buildingPerformance.map((building) => ({
      buildingId: building.buildingId,
      completionRate: building.operational.completionRate,
      overdueRate: building.operational.overdueRate,
      workOrdersTotal: building.workOrders.total,
      workOrdersOpen: building.workOrders.open,
      workOrdersCompleted: building.workOrders.completed,
      workOrdersOverdue: building.workOrders.overdue,
      findingsOpen: building.findings.open,
      findingsClosed: building.findings.closed,
      criticalFindings: building.findings.critical,
      assetsTotal: building.engineeringAssetHealth.totalAssets,
      assetsActive: building.engineeringAssetHealth.activeAssets,
      assetAvailabilityRate: building.engineeringAssetHealth.availabilityRate,
      pmComplianceRate:
        building.engineeringAssetHealth.pmCompliance.complianceRate,
      electricityConsumption: building.utility.electricityConsumption,
      waterConsumption: building.utility.waterConsumption,
      gasConsumption: building.utility.gasConsumption,
      tenantRequestsTotal: building.tenantService.totalRequests,
      tenantRequestsOpen: building.tenantService.openRequests,
      tenantRequestsCompleted: building.tenantService.completedRequests,
      tenantRequestsOverdue: building.tenantService.overdueRequests,
      tenantCompletionRate: building.tenantService.completionRate,
    })),
  );
}
