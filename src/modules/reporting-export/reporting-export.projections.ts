import type { PublicSecurityFindingIncidentKpi } from '../security-finding-incident-kpi';
import type { PublicSecurityPatrolKpi } from '../security-patrol-kpi';
import type { PublicUtilityKpi } from '../utility-kpi';
import type { PublicVendorTenantKpi } from '../vendor-tenant-kpi';
import type { PublicWorkforceKpi } from '../workforce-kpi';
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
