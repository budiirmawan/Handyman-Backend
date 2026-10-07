import type { PublicChecklistExecutionSummary } from '../checklist-execution-summary';
import type { PublicFindingRegister } from '../finding-register';
import type { PublicWorkOrderRegister } from '../work-order-register';
import type { PublicSecurityFindingIncidentKpi } from '../security-finding-incident-kpi';
import type { PublicSecurityPatrolKpi } from '../security-patrol-kpi';
import type { PublicUtilityKpi } from '../utility-kpi';
import type { PublicVendorServiceRegister } from '../vendor-service-register';
import type { PublicVendorTenantKpi } from '../vendor-tenant-kpi';
import type { PublicWorkforceKpi } from '../workforce-kpi';
import type { PublicOperationalDetail } from '../operational-detail-reporting';
import type {
  ReportingExportColumn,
  ReportingExportKpiValue,
  ReportingExportTable,
} from './reporting-export.types';

/**
 * BE-23J — projections from BE-23 KPI read models into the neutral
 * export envelope.
 *
 * EVERY function here is a pure re-shaping of an already-computed KPI
 * object. There is deliberately NO arithmetic: no sums, no rates, no
 * averages, no thresholds. Values are copied verbatim from the owning
 * BE-23 service, because that service is the single authority for them.
 * The only thing added is a stable key, a human label and a value type.
 *
 * That constraint is what keeps an export honest — a figure in a
 * spreadsheet can always be traced back to the KPI endpoint that
 * produced it, and the two can never disagree.
 */

const NUMBER = 'NUMBER' as const;
const PERCENT = 'PERCENT' as const;
const STRING = 'STRING' as const;
const DATE = 'DATE' as const;

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

/* ------------------------------------------------------------------ */
/*  BE-23F1 — Security Patrol & Activity                               */
/* ------------------------------------------------------------------ */

export function projectSecurityPatrol(source: PublicSecurityPatrolKpi): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const p = source.patrols;
  return {
    kpis: [
      kpi('patrolsScheduled', 'Patrols Scheduled', p.scheduled),
      kpi('patrolsCompleted', 'Patrols Completed', p.completed),
      kpi('patrolsInProgress', 'Patrols In Progress', p.inProgress),
      kpi('patrolsCancelled', 'Patrols Cancelled', p.cancelled),
      kpi('patrolsMissed', 'Patrols Missed', p.missed),
      kpi('patrolsOverdue', 'Patrols Overdue', p.overdue),
      kpi('patrolCompletionRate', 'Patrol Completion Rate', p.completionRate, PERCENT),
      kpi('dailyActivityCount', 'Daily Activity Count', source.dailyActivityCount),
    ],
    tables: [
      table(
        'patrolDailyActivity',
        'Patrol Daily Activity',
        [
          { key: 'date', label: 'Date', type: DATE },
          { key: 'scheduled', label: 'Scheduled', type: NUMBER },
          { key: 'completed', label: 'Completed', type: NUMBER },
          { key: 'missed', label: 'Missed', type: NUMBER },
          { key: 'overdue', label: 'Overdue', type: NUMBER },
          { key: 'completionRate', label: 'Completion Rate', type: PERCENT },
          { key: 'activityCount', label: 'Activity Count', type: NUMBER },
        ],
        source.dailyActivity.map((day) => ({
          date: day.date,
          scheduled: day.scheduled,
          completed: day.completed,
          missed: day.missed,
          overdue: day.overdue,
          completionRate: day.completionRate,
          activityCount: day.activityCount,
        })),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  BE-23F2 — Security Finding / Incident / Handover                   */
/* ------------------------------------------------------------------ */

const STATUS_COLUMNS: ReportingExportColumn[] = [
  { key: 'status', label: 'Status', type: STRING },
  { key: 'count', label: 'Count', type: NUMBER },
];

export function projectSecurityFindingIncident(
  source: PublicSecurityFindingIncidentKpi,
): { kpis: ReportingExportKpiValue[]; tables: ReportingExportTable[] } {
  const f = source.findings;
  const i = source.incidents;
  const h = source.shiftHandovers;
  return {
    kpis: [
      kpi('findingsTotal', 'Findings Total', f.total),
      kpi('findingsOpen', 'Findings Open', f.open),
      kpi('findingsOutstanding', 'Findings Outstanding', f.outstanding),
      kpi('findingsVerified', 'Findings Verified', f.verified),
      kpi('findingsClosed', 'Findings Closed', f.closed),
      kpi('incidentsTotal', 'Incidents Total', i.total),
      kpi('incidentsReported', 'Incidents Reported', i.reported),
      kpi('incidentsClosed', 'Incidents Closed', i.closed),
      kpi('handoversTotal', 'Shift Handovers Total', h.total),
      kpi('handoversDraft', 'Shift Handovers Draft', h.draft),
      kpi('handoversReady', 'Shift Handovers Ready', h.ready),
      kpi('handoversAcknowledged', 'Shift Handovers Acknowledged', h.acknowledged),
      kpi(
        'handoversPendingAcknowledgement',
        'Shift Handovers Pending Acknowledgement',
        h.pendingAcknowledgement,
      ),
    ],
    tables: [
      table(
        'findingsByStatus',
        'Findings by Status',
        STATUS_COLUMNS,
        f.byStatus.map((entry) => ({
          status: entry.status,
          count: entry.count,
        })),
      ),
      table(
        'incidentsByStatus',
        'Incidents by Status',
        STATUS_COLUMNS,
        i.byStatus.map((entry) => ({
          status: entry.status,
          count: entry.count,
        })),
      ),
      table(
        'incidentsBySeverity',
        'Incidents by Severity',
        [
          { key: 'severity', label: 'Severity', type: STRING },
          { key: 'count', label: 'Count', type: NUMBER },
        ],
        [
          { severity: 'LOW', count: i.bySeverity.low },
          { severity: 'MEDIUM', count: i.bySeverity.medium },
          { severity: 'HIGH', count: i.bySeverity.high },
          { severity: 'CRITICAL', count: i.bySeverity.critical },
        ],
      ),
      table(
        'handoversByStatus',
        'Shift Handovers by Status',
        STATUS_COLUMNS,
        h.byStatus.map((entry) => ({
          status: entry.status,
          count: entry.count,
        })),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  BE-23G — Workforce                                                 */
/* ------------------------------------------------------------------ */

export function projectWorkforce(source: PublicWorkforceKpi): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const w = source.workforce;
  const a = source.assignments;
  const m = source.manHours;
  return {
    kpis: [
      kpi('workforceTotal', 'Workforce Count', w.total),
      kpi('workforceActive', 'Workforce Active', w.active),
      kpi('workforceWithAssignments', 'Workforce With Assignments', w.withAssignments),
      kpi('assignmentsScheduled', 'Assignments Scheduled', a.scheduled),
      kpi('assignmentsCompleted', 'Assignments Completed', a.completed),
      kpi('assignmentsOverdue', 'Assignments Overdue', a.overdue),
      kpi('assignmentCompletionRate', 'Assignment Completion Rate', a.completionRate, PERCENT),
      kpi('manHoursTotal', 'Total Man-Hours', m.totalHours),
      kpi('manHoursMeasured', 'Measured Assignments', m.measuredAssignments),
      kpi('manHoursUnmeasured', 'Unmeasured Assignments', m.unmeasuredAssignments),
      kpi(
        'averageHoursPerAssignment',
        'Average Hours per Assignment',
        m.averageHoursPerAssignment,
      ),
      kpi(
        'averageHoursPerWorkforce',
        'Average Hours per Workforce',
        m.averageHoursPerWorkforce,
      ),
    ],
    tables: [
      table(
        'workforceByType',
        'Workforce by Type',
        [
          { key: 'workforceType', label: 'Workforce Type', type: STRING },
          { key: 'count', label: 'Count', type: NUMBER },
        ],
        [
          { workforceType: 'INTERNAL', count: w.internal },
          { workforceType: 'OUTSOURCED', count: w.outsourced },
          { workforceType: 'CONTRACT', count: w.contract },
        ],
      ),
      table(
        'workforceMembers',
        'Workforce Members',
        [
          { key: 'workforceId', label: 'Workforce Id', type: STRING },
          { key: 'employeeCode', label: 'Employee Code', type: STRING },
          { key: 'fullName', label: 'Full Name', type: STRING },
          { key: 'workforceType', label: 'Workforce Type', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'scheduled', label: 'Scheduled', type: NUMBER },
          { key: 'completed', label: 'Completed', type: NUMBER },
          { key: 'overdue', label: 'Overdue', type: NUMBER },
          { key: 'completionRate', label: 'Completion Rate', type: PERCENT },
          { key: 'totalHours', label: 'Total Hours', type: NUMBER },
        ],
        source.byWorkforce.map((member) => ({
          workforceId: member.workforceId,
          employeeCode: member.employeeCode,
          fullName: member.fullName,
          workforceType: member.workforceType,
          status: member.status,
          scheduled: member.scheduled,
          completed: member.completed,
          overdue: member.overdue,
          completionRate: member.completionRate,
          totalHours: member.totalHours,
        })),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  BE-23H — Vendor / Tenant                                           */
/* ------------------------------------------------------------------ */

export function projectVendorTenant(source: PublicVendorTenantKpi): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const v = source.vendorWork;
  const t = source.tenantService;
  return {
    kpis: [
      kpi('vendorWorkTotal', 'Vendor Work Total', v.total),
      kpi('vendorWorkCompleted', 'Vendor Work Completed', v.completed),
      kpi('vendorWorkOutstanding', 'Vendor Work Outstanding', v.outstanding),
      kpi('vendorWorkOverdue', 'Vendor Work Overdue', v.overdue),
      kpi('vendorCompletionRate', 'Vendor Completion Rate', v.completionRate, PERCENT),
      kpi(
        'vendorAverageCompletionHours',
        'Vendor Average Completion Hours',
        v.averageCompletionHours,
      ),
      kpi('tenantRequestsTotal', 'Tenant Service Requests', t.total),
      kpi('tenantRequestsOpen', 'Tenant Requests Open', t.open),
      kpi('tenantRequestsCompleted', 'Tenant Requests Completed', t.completed),
      kpi('tenantRequestsOutstanding', 'Tenant Requests Outstanding', t.outstanding),
      kpi('tenantCompletionRate', 'Tenant Completion Rate', t.completionRate, PERCENT),
    ],
    tables: [
      table(
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
        source.vendorPerformance.map((row) => ({
          vendorId: row.vendorId,
          vendorCode: row.vendorCode,
          vendorName: row.vendorName,
          vendorStatus: row.vendorStatus,
          total: row.total,
          completed: row.completed,
          outstanding: row.outstanding,
          overdue: row.overdue,
          completionRate: row.completionRate,
          averageCompletionHours: row.averageCompletionHours,
        })),
      ),
      table(
        'tenantRequestsByPriority',
        'Tenant Requests by Priority',
        [
          { key: 'priority', label: 'Priority', type: STRING },
          { key: 'count', label: 'Count', type: NUMBER },
        ],
        [
          { priority: 'LOW', count: t.byPriority.low },
          { priority: 'MEDIUM', count: t.byPriority.medium },
          { priority: 'HIGH', count: t.byPriority.high },
          { priority: 'CRITICAL', count: t.byPriority.critical },
        ],
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  BE-23I — Utility                                                   */
/* ------------------------------------------------------------------ */

export function projectUtility(source: PublicUtilityKpi): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const a = source.abnormal;
  const v = source.verification;
  return {
    kpis: [
      kpi('electricityConsumption', 'Electricity Consumption', source.electricity.totalConsumption),
      kpi('waterConsumption', 'Water Consumption', source.water.totalConsumption),
      kpi('gasConsumption', 'Gas Consumption', source.gas.totalConsumption),
      kpi('totalConsumption', 'Total Consumption', source.totals.totalConsumption),
      kpi('consumptionCount', 'Consumption Records', source.totals.consumptionCount),
      kpi('meterCount', 'Meters Contributing', source.totals.meterCount),
      kpi('abnormalTotal', 'Abnormal Consumptions', a.total),
      kpi('abnormalOpen', 'Abnormal Open', a.open),
      kpi('abnormalResolved', 'Abnormal Resolved', a.resolved),
      kpi('abnormalDismissed', 'Abnormal Dismissed', a.dismissed),
      kpi('verifiedReadings', 'Verified Readings', v.verified),
      kpi('verificationPending', 'Verification Pending', v.pending),
      kpi('verificationUnverified', 'Unverified', v.unverified),
    ],
    tables: [
      table(
        'consumptionByUtilityType',
        'Consumption by Utility Type',
        [
          { key: 'utilityType', label: 'Utility Type', type: STRING },
          { key: 'totalConsumption', label: 'Total Consumption', type: NUMBER },
          { key: 'consumptionCount', label: 'Consumption Records', type: NUMBER },
          { key: 'meterCount', label: 'Meters', type: NUMBER },
          { key: 'uomId', label: 'UOM Id', type: STRING },
        ],
        [source.electricity, source.water, source.gas].map((entry) => ({
          utilityType: entry.utilityType,
          totalConsumption: entry.totalConsumption,
          consumptionCount: entry.consumptionCount,
          meterCount: entry.meterCount,
          uomId: entry.uomId,
        })),
      ),
      table(
        'consumptionTrend',
        'Consumption Trend',
        [
          { key: 'intervalStart', label: 'Interval Start', type: DATE },
          { key: 'totalConsumption', label: 'Total Consumption', type: NUMBER },
          { key: 'consumptionCount', label: 'Consumption Records', type: NUMBER },
          { key: 'meterCount', label: 'Meters', type: NUMBER },
        ],
        source.trend.map((point) => ({
          intervalStart: point.intervalStart,
          totalConsumption: point.totalConsumption,
          consumptionCount: point.consumptionCount,
          meterCount: point.meterCount,
        })),
      ),
      table(
        'abnormalByType',
        'Abnormal Consumption by Type',
        [
          { key: 'abnormalityType', label: 'Abnormality Type', type: STRING },
          { key: 'count', label: 'Count', type: NUMBER },
        ],
        Object.entries(a.byType)
          .map(([abnormalityType, count]) => ({ abnormalityType, count }))
          .sort(
            (x, y) =>
              y.count - x.count ||
              x.abnormalityType.localeCompare(y.abnormalityType),
          ),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  CR-BE-REPORT-READ-01 — Vendor Service Register                     */
/* ------------------------------------------------------------------ */

/**
 * Neutral projection of the backend-owned Vendor Service Register read
 * model. One table row per read-contract row; every identifier, status,
 * decision, count, and timestamp is copied verbatim. Nulls are preserved
 * (a missing optional link is data, not a gap to fill).
 *
 * `kpis` is deliberately empty: a register carries no headline figures,
 * and this projection must not calculate any.
 */
export function projectVendorServiceRegister(
  source: PublicVendorServiceRegister,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'vendorServiceRegister',
        'Vendor Service Register',
        [
          { key: 'vendorWorkId', label: 'Vendor Work Id', type: STRING },
          {
            key: 'vendorAssignmentId',
            label: 'Vendor Assignment Id',
            type: STRING,
          },
          { key: 'assignedAt', label: 'Assigned At', type: DATE },
          { key: 'vendorId', label: 'Vendor Id', type: STRING },
          { key: 'vendorCode', label: 'Vendor Code', type: STRING },
          { key: 'vendorName', label: 'Vendor Name', type: STRING },
          { key: 'workOrderId', label: 'Work Order Id', type: STRING },
          { key: 'workOrderNumber', label: 'Work Order No', type: STRING },
          { key: 'workOrderStatus', label: 'Work Order Status', type: STRING },
          {
            key: 'functionalLocationId',
            label: 'Functional Location Id',
            type: STRING,
          },
          { key: 'assetId', label: 'Asset Id', type: STRING },
          { key: 'assetCode', label: 'Asset Code', type: STRING },
          { key: 'assetName', label: 'Asset Name', type: STRING },
          {
            key: 'vendorWorkStatus',
            label: 'Vendor Work Status',
            type: STRING,
          },
          {
            key: 'vendorWorkStartedAt',
            label: 'Work Started At',
            type: DATE,
          },
          {
            key: 'vendorWorkCompletedAt',
            label: 'Work Completed At',
            type: DATE,
          },
          {
            key: 'checklistBindingCount',
            label: 'Checklist Bindings',
            type: NUMBER,
          },
          {
            key: 'completionReportId',
            label: 'Completion Report Id',
            type: STRING,
          },
          {
            key: 'completionReportStatus',
            label: 'Completion Report Status',
            type: STRING,
          },
          {
            key: 'completionSubmittedAt',
            label: 'Completion Submitted At',
            type: DATE,
          },
          {
            key: 'serviceReportId',
            label: 'Service Report Id',
            type: STRING,
          },
          {
            key: 'serviceReportNumber',
            label: 'Service Report No',
            type: STRING,
          },
          {
            key: 'serviceReportStatus',
            label: 'Service Report Status',
            type: STRING,
          },
          {
            key: 'serviceReportDate',
            label: 'Service Date',
            type: DATE,
          },
          {
            key: 'serviceReportFinalizedAt',
            label: 'Service Report Finalized At',
            type: DATE,
          },
          {
            key: 'verificationReviewId',
            label: 'Verification Review Id',
            type: STRING,
          },
          {
            key: 'verificationDecision',
            label: 'Verification Decision',
            type: STRING,
          },
          {
            key: 'verificationReviewedAt',
            label: 'Verification Reviewed At',
            type: DATE,
          },
          { key: 'reworkCount', label: 'Rework Cycles', type: NUMBER },
          { key: 'latestReworkId', label: 'Latest Rework Id', type: STRING },
          {
            key: 'latestReworkStatus',
            label: 'Latest Rework Status',
            type: STRING,
          },
          { key: 'bastBindingId', label: 'BAST Binding Id', type: STRING },
          { key: 'bastNumber', label: 'BAST Number', type: STRING },
          { key: 'bastDate', label: 'BAST Date', type: DATE },
          {
            key: 'bastAcceptanceStatus',
            label: 'BAST Acceptance Status',
            type: STRING,
          },
          { key: 'bastSubmittedAt', label: 'BAST Submitted At', type: DATE },
          { key: 'bastAcceptedAt', label: 'BAST Accepted At', type: DATE },
          {
            key: 'canonicalBastDocumentId',
            label: 'Canonical BAST Document Id',
            type: STRING,
          },
          {
            key: 'canonicalBastAcceptanceStatus',
            label: 'Canonical BAST Acceptance Status',
            type: STRING,
          },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
        ],
        source.rows.map((row) => ({
          vendorWorkId: row.vendorWorkId,
          vendorAssignmentId: row.vendorAssignmentId,
          assignedAt: row.assignedAt,
          vendorId: row.vendorId,
          vendorCode: row.vendorCode,
          vendorName: row.vendorName,
          workOrderId: row.workOrderId,
          workOrderNumber: row.workOrderNumber,
          workOrderStatus: row.workOrderStatus,
          functionalLocationId: row.functionalLocationId,
          assetId: row.assetId,
          assetCode: row.assetCode,
          assetName: row.assetName,
          vendorWorkStatus: row.vendorWorkStatus,
          vendorWorkStartedAt: row.vendorWorkStartedAt,
          vendorWorkCompletedAt: row.vendorWorkCompletedAt,
          checklistBindingCount: row.checklistBindingCount,
          completionReportId: row.completionReportId,
          completionReportStatus: row.completionReportStatus,
          completionSubmittedAt: row.completionSubmittedAt,
          serviceReportId: row.serviceReportId,
          serviceReportNumber: row.serviceReportNumber,
          serviceReportStatus: row.serviceReportStatus,
          serviceReportDate: row.serviceReportDate,
          serviceReportFinalizedAt: row.serviceReportFinalizedAt,
          verificationReviewId: row.verificationReviewId,
          verificationDecision: row.verificationDecision,
          verificationReviewedAt: row.verificationReviewedAt,
          reworkCount: row.reworkCount,
          latestReworkId: row.latestReworkId,
          latestReworkStatus: row.latestReworkStatus,
          bastBindingId: row.bastBindingId,
          bastNumber: row.bastNumber,
          bastDate: row.bastDate,
          bastAcceptanceStatus: row.bastAcceptanceStatus,
          bastSubmittedAt: row.bastSubmittedAt,
          bastAcceptedAt: row.bastAcceptedAt,
          canonicalBastDocumentId: row.canonicalBastDocumentId,
          canonicalBastAcceptanceStatus: row.canonicalBastAcceptanceStatus,
          buildingId: row.buildingId,
          clientId: row.clientId,
        })),
      ),
    ],
  };
}

/**
 * CR-BE-REPORT-READ-02 PART 01 — Finding Register projection.
 *
 * Thin neutral projection over the backend-owned `getFindingRegister()` read
 * contract. Every identity, classification, severity, source, context,
 * lifecycle timestamp, assignment, evidence count, rework, verification,
 * closure, and history field is copied verbatim from the row the Finding
 * Register module already produced — this adapter does not recalculate,
 * infer, or label anything. Nulls are preserved. Boolean historyAvailable
 * is rendered as the STRING 'true'/'false' to keep the CSV/XLSX cell a
 * plain string (same convention used elsewhere in the codebase for
 * boolean-like flags).
 *
 * `kpis` is deliberately empty: a register carries no headline figures,
 * and this projection must not calculate any.
 */
export function projectFindingRegister(
  source: PublicFindingRegister,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'findingRegister',
        'Finding Register',
        [
          { key: 'findingId', label: 'Finding Id', type: STRING },
          { key: 'findingNumber', label: 'Finding No', type: STRING },
          { key: 'title', label: 'Title', type: STRING },
          { key: 'description', label: 'Description', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'classificationId', label: 'Classification Id', type: STRING },
          { key: 'classificationCode', label: 'Classification Code', type: STRING },
          { key: 'classificationName', label: 'Classification Name', type: STRING },
          { key: 'severityId', label: 'Severity Id', type: STRING },
          { key: 'severityCode', label: 'Severity Code', type: STRING },
          { key: 'severityName', label: 'Severity Name', type: STRING },
          { key: 'severityRank', label: 'Severity Rank', type: NUMBER },
          { key: 'sourceType', label: 'Source Type', type: STRING },
          { key: 'sourceId', label: 'Source Id', type: STRING },
          { key: 'sourceReferenceNumber', label: 'Source Reference No', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'assetId', label: 'Asset Id', type: STRING },
          { key: 'functionalLocationId', label: 'Functional Location Id', type: STRING },
          { key: 'reportedByUserId', label: 'Reported By User Id', type: STRING },
          { key: 'reportedAt', label: 'Reported At', type: DATE },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'stateChangedAt', label: 'State Changed At', type: DATE },
          { key: 'assigneeType', label: 'Assignee Type', type: STRING },
          { key: 'assignedWorkforceProfileId', label: 'Assigned Workforce Profile Id', type: STRING },
          { key: 'assignedTeamId', label: 'Assigned Team Id', type: STRING },
          { key: 'assignedVendorId', label: 'Assigned Vendor Id', type: STRING },
          { key: 'assignedByUserId', label: 'Assigned By User Id', type: STRING },
          { key: 'assignedAt', label: 'Assigned At', type: DATE },
          { key: 'evidenceCount', label: 'Evidence Count', type: NUMBER },
          { key: 'reworkCount', label: 'Rework Cycles', type: NUMBER },
          { key: 'latestReworkId', label: 'Latest Rework Id', type: STRING },
          { key: 'latestReworkStatus', label: 'Latest Rework Status', type: STRING },
          { key: 'latestReworkRequestedAt', label: 'Latest Rework Requested At', type: DATE },
          { key: 'verificationReviewId', label: 'Verification Review Id', type: STRING },
          { key: 'verificationReviewStatus', label: 'Verification Review Status', type: STRING },
          { key: 'verificationDecision', label: 'Verification Decision', type: STRING },
          { key: 'verificationReviewerUserId', label: 'Verification Reviewer User Id', type: STRING },
          { key: 'verificationReviewedAt', label: 'Verification Reviewed At', type: DATE },
          { key: 'closedAt', label: 'Closed At', type: DATE },
          { key: 'closedByUserId', label: 'Closed By User Id', type: STRING },
          { key: 'closureNotes', label: 'Closure Notes', type: STRING },
          { key: 'historyAvailable', label: 'History Available', type: STRING },
          { key: 'historyCount', label: 'History Count', type: NUMBER },
        ],
        source.rows.map((row) => ({
          findingId: row.findingId,
          findingNumber: row.findingNumber,
          title: row.title,
          description: row.description,
          status: row.status,
          classificationId: row.classificationId,
          classificationCode: row.classificationCode,
          classificationName: row.classificationName,
          severityId: row.severityId,
          severityCode: row.severityCode,
          severityName: row.severityName,
          severityRank: row.severityRank,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          sourceReferenceNumber: row.sourceReferenceNumber,
          clientId: row.clientId,
          buildingId: row.buildingId,
          assetId: row.assetId,
          functionalLocationId: row.functionalLocationId,
          reportedByUserId: row.reportedByUserId,
          reportedAt: row.reportedAt,
          createdAt: row.createdAt,
          stateChangedAt: row.stateChangedAt,
          assigneeType: row.assigneeType,
          assignedWorkforceProfileId: row.assignedWorkforceProfileId,
          assignedTeamId: row.assignedTeamId,
          assignedVendorId: row.assignedVendorId,
          assignedByUserId: row.assignedByUserId,
          assignedAt: row.assignedAt,
          evidenceCount: row.evidenceCount,
          reworkCount: row.reworkCount,
          latestReworkId: row.latestReworkId,
          latestReworkStatus: row.latestReworkStatus,
          latestReworkRequestedAt: row.latestReworkRequestedAt,
          verificationReviewId: row.verificationReviewId,
          verificationReviewStatus: row.verificationReviewStatus,
          verificationDecision: row.verificationDecision,
          verificationReviewerUserId: row.verificationReviewerUserId,
          verificationReviewedAt: row.verificationReviewedAt,
          closedAt: row.closedAt,
          closedByUserId: row.closedByUserId,
          closureNotes: row.closureNotes,
          historyAvailable: row.historyAvailable ? 'true' : 'false',
          historyCount: row.historyCount,
        })),
      ),
    ],
  };
}

export function projectWorkOrderRegister(
  source: PublicWorkOrderRegister,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'workOrderRegister',
        'Work Order Register',
        [
          { key: 'workOrderId', label: 'Work Order Id', type: STRING },
          { key: 'workOrderNumber', label: 'Work Order No', type: STRING },
          { key: 'title', label: 'Title', type: STRING },
          { key: 'description', label: 'Description', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'assetId', label: 'Asset Id', type: STRING },
          { key: 'assetCode', label: 'Asset Code', type: STRING },
          { key: 'assetName', label: 'Asset Name', type: STRING },
          { key: 'functionalLocationId', label: 'Functional Location Id', type: STRING },
          { key: 'functionalLocationCode', label: 'Functional Location Code', type: STRING },
          { key: 'functionalLocationName', label: 'Functional Location Name', type: STRING },
          { key: 'workType', label: 'Work Type', type: STRING },
          { key: 'priority', label: 'Priority', type: STRING },
          { key: 'bastRequirement', label: 'BAST Requirement', type: STRING },
          { key: 'workRequestId', label: 'Work Request Id', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'assignedAt', label: 'Assigned At', type: DATE },
          { key: 'startedAt', label: 'Started At', type: DATE },
          { key: 'completedAt', label: 'Completed At', type: DATE },
          { key: 'closedAt', label: 'Closed At', type: DATE },
          { key: 'cancelledAt', label: 'Cancelled At', type: DATE },
          { key: 'assigneeType', label: 'Assignee Type', type: STRING },
          { key: 'assignedWorkforceProfileId', label: 'Assigned Workforce Profile Id', type: STRING },
          { key: 'assignedTeamId', label: 'Assigned Team Id', type: STRING },
          { key: 'assignedVendorId', label: 'Assigned Vendor Id', type: STRING },
          { key: 'assignedByUserId', label: 'Assigned By User Id', type: STRING },
          { key: 'assignmentAssignedAt', label: 'Assignment Assigned At', type: DATE },
          { key: 'evidenceCount', label: 'Evidence Count', type: NUMBER },
          { key: 'findingCount', label: 'Finding Count', type: NUMBER },
          { key: 'verificationReviewId', label: 'Verification Review Id', type: STRING },
          { key: 'verificationReviewStatus', label: 'Verification Review Status', type: STRING },
          { key: 'verificationDecision', label: 'Verification Decision', type: STRING },
          { key: 'verificationReviewerUserId', label: 'Verification Reviewer User Id', type: STRING },
          { key: 'verificationReviewedAt', label: 'Verification Reviewed At', type: DATE },
          { key: 'completedByUserId', label: 'Completed By User Id', type: STRING },
          { key: 'completionSummary', label: 'Completion Summary', type: STRING },
          { key: 'completionNotes', label: 'Completion Notes', type: STRING },
          { key: 'historyAvailable', label: 'History Available', type: STRING },
          { key: 'historyCount', label: 'History Count', type: NUMBER },
        ],
        source.rows.map((row) => ({
          workOrderId: row.workOrderId,
          workOrderNumber: row.workOrderNumber,
          title: row.title,
          description: row.description,
          status: row.status,
          clientId: row.clientId,
          buildingId: row.buildingId,
          assetId: row.assetId,
          assetCode: row.assetCode,
          assetName: row.assetName,
          functionalLocationId: row.functionalLocationId,
          functionalLocationCode: row.functionalLocationCode,
          functionalLocationName: row.functionalLocationName,
          workType: row.workType,
          priority: row.priority,
          bastRequirement: row.bastRequirement,
          workRequestId: row.workRequestId,
          createdAt: row.createdAt,
          assignedAt: row.assignedAt,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          closedAt: row.closedAt,
          cancelledAt: row.cancelledAt,
          assigneeType: row.assigneeType,
          assignedWorkforceProfileId: row.assignedWorkforceProfileId,
          assignedTeamId: row.assignedTeamId,
          assignedVendorId: row.assignedVendorId,
          assignedByUserId: row.assignedByUserId,
          assignmentAssignedAt: row.assignmentAssignedAt,
          evidenceCount: row.evidenceCount,
          findingCount: row.findingCount,
          verificationReviewId: row.verificationReviewId,
          verificationReviewStatus: row.verificationReviewStatus,
          verificationDecision: row.verificationDecision,
          verificationReviewerUserId: row.verificationReviewerUserId,
          verificationReviewedAt: row.verificationReviewedAt,
          completedByUserId: row.completedByUserId,
          completionSummary: row.completionSummary,
          completionNotes: row.completionNotes,
          historyAvailable: row.historyAvailable ? 'true' : 'false',
          historyCount: row.historyCount,
        })),
      ),
    ],
  };
}

export function projectChecklistExecutionSummary(
  source: PublicChecklistExecutionSummary,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'checklistExecutionSummary',
        'Checklist Execution Summary',
        [
          { key: 'engine', label: 'Engine', type: STRING },
          { key: 'executionId', label: 'Execution Id', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'startedAt', label: 'Started At', type: DATE },
          { key: 'completedAt', label: 'Completed At', type: DATE },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
          { key: 'templateId', label: 'Template Id', type: STRING },
          { key: 'templateCode', label: 'Template Code', type: STRING },
          { key: 'templateName', label: 'Template Name', type: STRING },
          { key: 'templateVersionId', label: 'Template Version Id', type: STRING },
          { key: 'templateVersionNumber', label: 'Template Version No', type: NUMBER },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'assetId', label: 'Asset Id', type: STRING },
          { key: 'functionalLocationId', label: 'Functional Location Id', type: STRING },
          { key: 'vendorId', label: 'Vendor Id', type: STRING },
          { key: 'itemCount', label: 'Item Count', type: NUMBER },
          { key: 'evidenceCount', label: 'Evidence Count', type: NUMBER },
          { key: 'findingCount', label: 'Finding Count', type: NUMBER },
          { key: 'verificationReviewId', label: 'Verification Review Id', type: STRING },
          { key: 'verificationReviewStatus', label: 'Verification Review Status', type: STRING },
          { key: 'verificationDecision', label: 'Verification Decision', type: STRING },
          { key: 'verificationReviewerUserId', label: 'Verification Reviewer User Id', type: STRING },
          { key: 'verificationReviewedAt', label: 'Verification Reviewed At', type: DATE },
        ],
        source.rows.map((row) => ({
          engine: row.engine,
          executionId: row.executionId,
          status: row.status,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          templateId: row.templateId,
          templateCode: row.templateCode,
          templateName: row.templateName,
          templateVersionId: row.templateVersionId,
          templateVersionNumber: row.templateVersionNumber,
          clientId: row.clientId,
          buildingId: row.buildingId,
          assetId: row.assetId,
          functionalLocationId: row.functionalLocationId,
          vendorId: row.vendorId,
          itemCount: row.itemCount,
          evidenceCount: row.evidenceCount,
          findingCount: row.findingCount,
          verificationReviewId: row.verificationReviewId,
          verificationReviewStatus: row.verificationReviewStatus,
          verificationDecision: row.verificationDecision,
          verificationReviewerUserId: row.verificationReviewerUserId,
          verificationReviewedAt: row.verificationReviewedAt,
        })),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  R07 PART 03B — Operational Detail                                  */
/* ------------------------------------------------------------------ */

/**
 * Neutral projection of the R07 operational detail read model.
 * One table row per neutral detail row (engine + execution + item/field + occurrence).
 * Every identifier, status, timestamp, measurement, value, attribution, verification
 * is copied verbatim. Nulls preserved: missing optional link is data, not gap.
 *
 * kpis deliberately empty: detail carries no headline figures.
 * No PASS/FAIL calculation, no semantic normalization, no executor, no display names, no evidence/finding/rework.
 *
 * Value serialization: renderer-compatible scalar only (string|number|boolean|null).
 * If unexpected array/object reaches projection, we let renderer fail via UNSUPPORTED_CELL_VALUE (do not silently stringify).
 *
 * responseState presentation-only derived from authoritative facts:
 *   responseId == NULL => UNANSWERED
 *   engine == CHECKLIST_EXECUTION && responseId != NULL && isNa == TRUE => EXPLICIT_NA
 *   responseId != NULL && value == NULL => RESPONDED_NULL
 *   responseId != NULL => RESPONDED
 */

const BOOLEAN = 'BOOLEAN' as const;

function serializeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // Unexpected complex JSON (array/object) — return as-is to let renderer fail via UNSUPPORTED_CELL_VALUE
  // Do NOT silently JSON.stringify
  return value as unknown as string;
}

function deriveResponseState(row: {
  responseId: string | null;
  engine: string;
  isNa: boolean | null;
  value: unknown | null;
}): string {
  if (row.responseId == null) return 'UNANSWERED';
  if (row.engine === 'CHECKLIST_EXECUTION' && row.responseId != null && row.isNa === true) return 'EXPLICIT_NA';
  if (row.responseId != null && row.value == null) return 'RESPONDED_NULL';
  return 'RESPONDED';
}

export function projectOperationalDetail(
  source: PublicOperationalDetail,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'operationalDetail',
        'Operational Detail',
        [
          { key: 'engine', label: 'Engine', type: STRING },
          { key: 'executionId', label: 'Execution Id', type: STRING },
          { key: 'definitionItemId', label: 'Definition Item Id', type: STRING },
          { key: 'definitionCode', label: 'Definition Code', type: STRING },
          { key: 'responseId', label: 'Response Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'templateId', label: 'Template Id', type: STRING },
          { key: 'templateCode', label: 'Template Code', type: STRING },
          { key: 'templateName', label: 'Template Name', type: STRING },
          { key: 'status', label: 'Execution Status', type: STRING },
          { key: 'startedAt', label: 'Started At', type: DATE },
          { key: 'completedAt', label: 'Completed At', type: DATE },
          { key: 'sectionCode', label: 'Section Code', type: STRING },
          { key: 'sectionTitle', label: 'Section Title', type: STRING },
          { key: 'sectionDisplayOrder', label: 'Section Display Order', type: NUMBER },
          { key: 'occurrenceIndex', label: 'Occurrence Index', type: NUMBER },
          { key: 'label', label: 'Label', type: STRING },
          { key: 'type', label: 'Type', type: STRING },
          { key: 'displayOrder', label: 'Display Order', type: NUMBER },
          { key: 'required', label: 'Required', type: BOOLEAN },
          { key: 'uomId', label: 'UOM Id', type: STRING },
          { key: 'uomSymbol', label: 'UOM Symbol', type: STRING },
          { key: 'minimumValue', label: 'Minimum Value', type: STRING },
          { key: 'maximumValue', label: 'Maximum Value', type: STRING },
          { key: 'decimalPrecision', label: 'Decimal Precision', type: NUMBER },
          { key: 'value', label: 'Value', type: STRING },
          { key: 'result', label: 'Result', type: STRING },
          { key: 'notes', label: 'Notes', type: STRING },
          { key: 'isNa', label: 'Is N/A', type: BOOLEAN },
          { key: 'naNotes', label: 'N/A Notes', type: STRING },
          { key: 'optionCode', label: 'Option Code', type: STRING },
          { key: 'optionLabel', label: 'Option Label', type: STRING },
          { key: 'isNaAllowed', label: 'Is N/A Allowed', type: BOOLEAN },
          { key: 'naRequiresNote', label: 'N/A Requires Note', type: BOOLEAN },
          { key: 'responseCreatedAt', label: 'Response Created At', type: DATE },
          { key: 'responseUpdatedAt', label: 'Response Updated At', type: DATE },
          { key: 'lastRespondedByUserId', label: 'Last Responded By User Id', type: STRING },
          { key: 'completedByUserId', label: 'Completed By User Id', type: STRING },
          { key: 'assigneeType', label: 'Assignee Type', type: STRING },
          { key: 'assignedWorkforceProfileId', label: 'Assigned Workforce Profile Id', type: STRING },
          { key: 'assignedTeamId', label: 'Assigned Team Id', type: STRING },
          { key: 'assignmentSnapshotAt', label: 'Assignment Snapshot At', type: DATE },
          { key: 'verificationStatus', label: 'Verification Status', type: STRING },
          { key: 'verificationDecision', label: 'Verification Decision', type: STRING },
          { key: 'verificationReviewerUserId', label: 'Verification Reviewer User Id', type: STRING },
          { key: 'verificationReviewedAt', label: 'Verification Reviewed At', type: DATE },
          { key: 'definitionMetadataAuthority', label: 'Definition Metadata Authority', type: STRING },
          { key: 'measurementMetadataAuthority', label: 'Measurement Metadata Authority', type: STRING },
          { key: 'responseState', label: 'Response State', type: STRING },
        ],
        source.rows.map((row) => ({
          engine: row.engine,
          executionId: row.executionId,
          definitionItemId: row.definitionItemId,
          definitionCode: row.definitionCode,
          responseId: row.responseId,
          clientId: row.clientId,
          buildingId: row.buildingId,
          templateId: row.templateId,
          templateCode: row.templateCode,
          templateName: row.templateName,
          status: row.status,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          sectionCode: row.sectionCode,
          sectionTitle: row.sectionTitle,
          sectionDisplayOrder: row.sectionDisplayOrder,
          occurrenceIndex: row.occurrenceIndex,
          label: row.label,
          type: row.type,
          displayOrder: row.displayOrder,
          required: row.required,
          uomId: row.uomId,
          uomSymbol: row.uomSymbol,
          minimumValue: row.minimumValue,
          maximumValue: row.maximumValue,
          decimalPrecision: row.decimalPrecision,
          value: serializeValue(row.value),
          result: row.result,
          notes: row.notes,
          isNa: row.isNa,
          naNotes: row.naNotes,
          optionCode: row.optionCode,
          optionLabel: row.optionLabel,
          isNaAllowed: row.isNaAllowed,
          naRequiresNote: row.naRequiresNote,
          responseCreatedAt: row.responseCreatedAt,
          responseUpdatedAt: row.responseUpdatedAt,
          lastRespondedByUserId: row.lastRespondedByUserId,
          completedByUserId: row.completedByUserId,
          assigneeType: row.assigneeType,
          assignedWorkforceProfileId: row.assignedWorkforceProfileId,
          assignedTeamId: row.assignedTeamId,
          assignmentSnapshotAt: row.assignmentSnapshotAt,
          verificationStatus: row.verificationStatus,
          verificationDecision: row.verificationDecision,
          verificationReviewerUserId: row.verificationReviewerUserId,
          verificationReviewedAt: row.verificationReviewedAt,
          definitionMetadataAuthority: row.definitionMetadataAuthority,
          measurementMetadataAuthority: row.measurementMetadataAuthority,
          responseState: deriveResponseState(row),
        })),
      ),
      table(
        'operationalDetailAttribution',
        'Operational Detail Attribution',
        [
          { key: 'engine', label: 'Engine', type: STRING },
          { key: 'executionId', label: 'Execution ID', type: STRING },
          { key: 'definitionItemId', label: 'Definition Item ID', type: STRING },
          { key: 'responseId', label: 'Response ID', type: STRING },
          { key: 'occurrenceId', label: 'Occurrence ID', type: STRING },
          { key: 'completedByUserId', label: 'Completed By User ID', type: STRING },
          { key: 'completedByName', label: 'Completed By', type: STRING },
          { key: 'lastRespondedByUserId', label: 'Last Responded By User ID', type: STRING },
          { key: 'lastRespondedByName', label: 'Last Responded By', type: STRING },
          { key: 'verificationReviewerUserId', label: 'Verification Reviewer User ID', type: STRING },
          { key: 'verificationReviewerName', label: 'Verified By', type: STRING },
          { key: 'assigneeType', label: 'Assignee Type', type: STRING },
          { key: 'assignedWorkforceProfileId', label: 'Assigned Workforce Profile ID', type: STRING },
          { key: 'assignedWorkforceName', label: 'Assigned Workforce', type: STRING },
          { key: 'assignedTeamId', label: 'Assigned Team ID', type: STRING },
          { key: 'assignedTeamName', label: 'Assigned Team', type: STRING },
          { key: 'assignmentSnapshotAt', label: 'Assignment Snapshot At', type: DATE },
        ],
        source.rows.map((row) => ({
          engine: row.engine,
          executionId: row.executionId,
          definitionItemId: row.definitionItemId,
          responseId: row.responseId,
          occurrenceId: row.occurrenceId,
          completedByUserId: row.completedByUserId,
          completedByName: row.completedByName,
          lastRespondedByUserId: row.lastRespondedByUserId,
          lastRespondedByName: row.lastRespondedByName,
          verificationReviewerUserId: row.verificationReviewerUserId,
          verificationReviewerName: row.verificationReviewerName,
          assigneeType: row.assigneeType,
          assignedWorkforceProfileId: row.assignedWorkforceProfileId,
          assignedWorkforceName: row.assignedWorkforceName,
          assignedTeamId: row.assignedTeamId,
          assignedTeamName: row.assignedTeamName,
          assignmentSnapshotAt: row.assignmentSnapshotAt,
        })),
      ),
    ],
  };
}
