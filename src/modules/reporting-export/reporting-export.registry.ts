import {
  findingRegisterService,
  getFindingRegister,
  parseFindingRegisterQuery,
} from '../finding-register';
import {
  managementOperationsCommandCenterService,
  parseManagementOperationsCommandCenterQuery,
} from '../management-operations-command-center';
import {
  parseFindingIncidentKpiQuery,
  securityFindingIncidentKpiService,
} from '../security-finding-incident-kpi';
import {
  parsePatrolKpiQuery,
  securityPatrolKpiService,
} from '../security-patrol-kpi';
import { parseUtilityKpiQuery, utilityKpiService } from '../utility-kpi';
import {
  checklistExecutionSummaryService,
  getChecklistExecutionSummary,
  parseChecklistExecutionSummaryQuery,
} from '../checklist-execution-summary';
import {
  getVendorServiceRegister,
  parseVendorServiceRegisterQuery,
} from '../vendor-service-register';
import {
  getWorkOrderRegister,
  parseWorkOrderRegisterQuery,
  workOrderRegisterService,
} from '../work-order-register';
import {
  getWorkOrderSlaRegister,
  parseWorkOrderSlaRegisterQuery,
} from '../work-order-sla-register';
import {
  getScheduledOperationLineage,
  parseScheduledOperationLineageQuery,
  scheduledOperationLineageService,
} from '../scheduled-operation-lineage';
import {
  getPermitToWorkRegister,
  parsePermitToWorkRegisterQuery,
} from '../permit-to-work-register';
// The owning module's index also exports `securityReportRepository`; it is deliberately NOT
// imported here. Reporting goes through the public service so Building access assertion,
// period normalization and the patrol, shift-handover, security-finding and incident-readiness
// queries all stay with BE-12M. `HANDOVER_REPORT_STATUSES`, `FINDING_REPORT_STATUSES` and
// `INCIDENT_READINESS_REPORT_STATUSES` are the owning module's own published status
// vocabularies for those dataset endpoints, reused verbatim so Reporting declares no
// competing vocabulary.
import {
  FINDING_REPORT_STATUSES,
  HANDOVER_REPORT_STATUSES,
  INCIDENT_READINESS_REPORT_STATUSES,
  parseReportQuery,
  securityReportService,
} from '../security-reports';
import {
  parseVendorTenantKpiQuery,
  vendorTenantKpiService,
} from '../vendor-tenant-kpi';
import { parseWorkforceKpiQuery, workforceKpiService } from '../workforce-kpi';
import {
  getOperationalDetail,
  parseOperationalDetailQuery,
} from '../operational-detail-reporting';
import {
  listCorrectiveActions,
  parseCorrectiveActionFilters,
} from '../corrective-actions';
import {
  getOperationalDetailEvidence,
  parseOperationalDetailEvidenceQuery,
  type PublicOperationalDetailEvidence,
  type PublicOperationalDetailEvidenceRow,
} from '../operational-detail-evidence';
import {
  getOperationalDetailFindingRework,
  parseOperationalDetailFindingReworkQuery,
  type PublicOperationalDetailFindingRework,
  type PublicOperationalDetailFindingReworkRow,
} from '../operational-detail-finding-rework';
import {
  getOperationalDetailReviewHistory,
  parseOperationalDetailReviewHistoryQuery,
  type PublicOperationalDetailReviewHistory,
  type PublicOperationalDetailReviewHistoryRow,
} from '../operational-detail-review-history';
// R10 PART 19 — the owning module's public index also exports `incidentRepository` and
// `createIncidentRouter`; neither is imported here. Reporting goes through the governed
// `listIncidents` read so Building access assertion, accessible-Building scoping in SQL and the
// incident query all stay with BE-21A, and `parseIncidentFilters` is reused verbatim so Reporting
// declares no competing incident filter contract, status vocabulary or lifecycle authority.
import { incidentService, listIncidents, parseIncidentFilters } from '../incidents';
// R11 PART 02 — the owning module's public index also exports `receivingRegisterRepository`; it is
// deliberately NOT imported here. Reporting goes through the governed public read
// (`getReceivingRegister`) so Building access assertion, accessible-Building scoping in SQL, the
// half-open `received_at` window and the receiving query all stay with the PART 01 read contract,
// and `parseReceivingRegisterQuery` is reused verbatim so Reporting declares no competing receiving
// filter contract, status vocabulary or lifecycle authority.
import {
  getReceivingRegister,
  parseReceivingRegisterQuery,
} from '../receiving-register';
// R11 PART 03C — HEADER view source authority. The purchase-orders public index also exports
// `purchaseOrderRepository` and `purchaseOrderLineRepository`; NEITHER is imported here. The
// HEADER view goes through the governed public read (`listPurchaseOrders`) so filter validation,
// Building access assertion, accessible-Building scoping in SQL, the native status vocabulary and
// the `po_date DESC, created_at DESC` ordering all stay with CR-BE-R2P-01, and no header SQL is
// duplicated in Reporting.
import {
  listPurchaseOrders,
  parsePurchaseOrderFilters,
} from '../purchase-orders';
// R11 PART 03C — LINE view source authority (R11 PART 03B). Its public index also exports
// `purchaseOrderLineRegisterRepository`; it is deliberately NOT imported here. The LINE view goes
// through the governed public read (`getPurchaseOrderLineRegister`) so the nine-filter contract,
// strict calendar-date validation, the set-based structurally-joined cross-PO query, the
// fail-closed Building scope and the inclusive `po_date` window all stay with the owning module.
import {
  getPurchaseOrderLineRegister,
  parsePurchaseOrderLineRegisterQuery,
} from '../purchase-order-line-register';
// R11 PART 04 — the vendor-invoices public index also exports `vendorInvoiceRepository`; it is
// deliberately NOT imported here. The register goes through the governed public read
// (`listVendorInvoices`) so Building access assertion, accessible-Building scoping in SQL,
// fail-closed empty-scope behavior, the native status vocabularies and the `invoice_date DESC,
// created_at DESC` ordering all stay with CR-BE-COM-02, and `parseVendorInvoiceFilters` is
// reused verbatim so Reporting declares no competing invoice filter contract, no second date
// parser and no lifecycle, verification, payment or matching authority.
import {
  listVendorInvoices,
  parseVendorInvoiceFilters,
} from '../vendor-invoices';
// R11 PART 05C — STOCK_MOVEMENT_REGISTER source authority (R11 PART 05B). Its public index also
// exports `stockMovementRegisterRepository`; it is deliberately NOT imported here. The register
// goes through the governed public read (`getStockMovementRegister`) so the strict real-calendar
// date validation, the half-open UTC `movement_date` window normalization, the explicit-Building
// access assertion, the accessible-Building rollup, the fail-closed empty scope, the structural
// Building-set SQL scope and the native STOCK_IN/STOCK_OUT vocabulary validation all stay with
// the PART 05B foundation, and `parseStockMovementRegisterQuery` is reused verbatim so Reporting
// declares no competing movement filter contract and no second date parser. The owning
// inventory-stock-movements public list (`listMovements`) is deliberately NOT consumed: R11
// PART 05 source verification proved it is not actor-scoped, has no fail-closed empty scope and
// truncates the final day of a date-only upper bound.
import {
  getStockMovementRegister,
  parseStockMovementRegisterQuery,
} from '../stock-movement-register';
// R11 PART 06 — OPERATIONAL_BUDGET_VARIANCE source authority (CR-BE-COMM-VAR-01). The
// operational-finance public index also exports `operationalFinanceRepository`,
// `operationalVarianceRepository`, `operationalCommitmentRepository`,
// `operationalFinanceBindingRepository`, the aggregation service/repositories, HTTP handlers
// and the router; NONE are imported here. Both views go through the governed public variance
// reads (`operationalVarianceService.listOperationalBudgetVariance` /
// `.getOperationalBudgetVariance`) so the Building access assertion, the accessible-Building
// rollup, the structural Building-set SQL scope with fail-closed empty scope, the budget
// existence check, ALL variance/commitment/actual/available/percentage math, the gap and
// exclusion control vocabulary and the native budget status and overspend-policy vocabularies
// stay with the owning module, and `parseOperationalBudgetFilters` /
// `parseOperationalBudgetIdParam` are reused verbatim so Reporting declares no competing budget
// filter contract and no second period parser. The budget traceability read
// (`getOperationalBudgetTraceability`) is deliberately NOT consumed: it remains a separate
// drill authority and this dataset is no traceability mega-read.
import {
  operationalVarianceService,
  parseOperationalBudgetFilters,
  parseOperationalBudgetIdParam,
} from '../operational-finance';
// R12 PART 02 — ESG_METRIC_TREND source authority. Reporting uses the public bounded read only;
// it does not import the repository, duplicate ESG SQL, accept client scope or infer utility/carbon
// semantics. The source owns authenticated Building intersection and complete-period containment.
import {
  esgMetricValueService,
  type EsgMetricValueReadRequest,
} from '../esg-metric-values';
// R12 PART 03 — Reporting consumes the bounded ESG waste source read only. The source owns
// authenticated Building intersection, inclusive period_date bounds and the set-based repository
// query; Reporting never imports waste SQL, accepts Client scope or loops over Buildings.
import {
  esgWasteRecordService,
  type EsgWasteRecordReadRequest,
} from '../esg-waste-records';
// R12 PART 04 — the utility source seam reads persisted consumption facts in one bounded,
// actor-scoped Building-set query. Reporting does not call utility aggregation per Building and
// never recomputes reading deltas, hierarchy, cost, carbon or UOM conversion.
import {
  utilityMeterConsumptionService,
  type UtilityConsumptionTrendReadRequest,
} from '../utility-meter-consumptions';
import type { UtilityType } from '../utility-meters/utility-meter.types';
import {
  projectFindingRegister,
  projectOperationalDetail,
  projectSecurityFindingIncident,
  projectSecurityPatrol,
  projectUtility,
  projectVendorServiceRegister,
  projectVendorTenant,
  projectWorkforce,
  projectWorkOrderRegister,
  projectChecklistExecutionSummary,
} from './reporting-export.projections';
import { projectManagementOperationsCommandCenter } from './reporting-export.management-projections';
import {
  projectCorrectiveAction,
  projectOperationalDetailEvidence,
  projectOperationalDetailFindingRework,
  projectOperationalDetailReviewHistory,
  projectWorkOrderSla,
  projectScheduledOperationLineage,
  projectPermitToWorkLifecycle,
  projectPermitToWorkApproval,
  projectSecurityOperationalFinding,
  projectSecurityOperationalIncidentReadiness,
  projectSecurityOperationalPatrol,
  projectSecurityOperationalShiftHandover,
  projectIncidentRegister,
} from './reporting-export.r10-projections';
// R11 PART 02 — R11 projections live in their own seam file, following the r10-projections
// precedent; the R01–R09 and R10 projection files are untouched.
import {
  projectOperationalBudgetVariance,
  projectOperationalBudgetVarianceCategory,
  projectPurchaseOrderHeader,
  projectPurchaseOrderLine,
  projectReceivingRegister,
  projectStockMovementRegister,
  projectVendorInvoiceRegister,
} from './reporting-export.r11-projections';
import {
  projectEsgMetricTrend,
  projectEsgWasteRegister,
  projectPortfolioOperationalComparison,
  projectUtilityConsumptionTrend,
} from './reporting-export.r12-projections';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isOperationalBudgetVarianceView,
  isOperationalDetailHistoryValue,
  isPurchaseOrderRegisterView,
  isSecurityOperationalDetailSource,
  OPERATIONAL_BUDGET_VARIANCE_VIEWS,
  OPERATIONAL_DETAIL_HISTORY_VALUES,
  PURCHASE_ORDER_REGISTER_VIEWS,
  SECURITY_OPERATIONAL_DETAIL_SOURCES,
  PORTFOLIO_OPERATIONAL_COMPARISON_METRICS,
  REPORTING_EXPORT_DATASETS,
  isReportingExportDataset,
  type OperationalBudgetVarianceView,
  type OperationalDetailHistoryValue,
  type PortfolioOperationalComparisonMetric,
  type PublicPortfolioOperationalComparisonRow,
  type PurchaseOrderRegisterView,
  type ReportingExportDataset,
  type SecurityOperationalDetailSource,
  type ReportingExportKpiValue,
  type ReportingExportTable,
} from './reporting-export.types';

/**
 * CR-BE-EXP-01 PART 05 — governed dataset registry.
 *
 * Each adapter delegates filtering and calculation to the read-model/KPI
 * authority that already owns it, then returns the same neutral projection
 * consumed by every format renderer. This registry does not query source
 * tables, calculate KPIs, or create a second reporting authority.
 */

type CommonExportEnvelope = {
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
};

export type ReportingExportProjection = {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
};

export type ReportingExportAdapterResult = {
  common: CommonExportEnvelope;
  projected: ReportingExportProjection;
  appliedFilters: Record<string, string | number | boolean | null>;
};

export type ReportingExportDatasetAdapter = {
  dataset: ReportingExportDataset;
  datasetLabel: string;
  sourceAuthority: string;
  requiredReadPermission: string;
  load: (
    passThrough: Record<string, unknown>,
    userId: string,
  ) => Promise<ReportingExportAdapterResult>;
};

function echoFilters(
  parsed: Record<string, unknown>,
  extra: Record<string, string | number | boolean | null> = {},
): Record<string, string | number | boolean | null> {
  const filters: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      filters[key] = value;
    }
  }
  return { ...filters, ...extra };
}

function readEsgMetricTrendRequest(
  passThrough: Record<string, unknown>,
): EsgMetricValueReadRequest {
  const details: Array<{ field: string; message: string }> = [];
  const buildingIds = readEsgMetricTrendStringSet(
    passThrough.buildingIds,
    'buildingIds',
    true,
    details,
  );
  const metricDefinitionIds = readEsgMetricTrendStringSet(
    passThrough.metricDefinitionIds,
    'metricDefinitionIds',
    false,
    details,
  );
  const periodStart = readEsgMetricTrendPeriod(
    passThrough.periodStart,
    'periodStart',
    details,
  );
  const periodEnd = readEsgMetricTrendPeriod(passThrough.periodEnd, 'periodEnd', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingIds: buildingIds!,
    ...(metricDefinitionIds === undefined ? {} : { metricDefinitionIds }),
    periodStart: periodStart!,
    periodEnd: periodEnd!,
  };
}

function readEsgMetricTrendStringSet(
  value: unknown,
  field: string,
  required: boolean,
  details: Array<{ field: string; message: string }>,
): string[] | undefined {
  if (value === undefined) {
    if (required) {
      details.push({ field, message: `${field} is required and must be a non-empty set.` });
    }
    return required ? [] : undefined;
  }

  const values = Array.isArray(value) ? value : [value];
  if (
    (required && values.length === 0) ||
    values.some((candidate) => typeof candidate !== 'string' || candidate.length === 0)
  ) {
    details.push({
      field,
      message: `${field} must be ${required ? 'a non-empty set' : 'a set'} of strings.`,
    });
  }
  return values as string[];
}

function readEsgMetricTrendPeriod(
  value: unknown,
  field: string,
  details: Array<{ field: string; message: string }>,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    details.push({ field, message: `${field} is required and must be a string.` });
    return undefined;
  }
  return value;
}

function readEsgWasteRegisterRequest(
  passThrough: Record<string, unknown>,
): EsgWasteRecordReadRequest {
  const details: Array<{ field: string; message: string }> = [];
  const rawBuildingIds = passThrough.buildingIds;
  const buildingIds =
    rawBuildingIds === undefined
      ? []
      : Array.isArray(rawBuildingIds)
        ? rawBuildingIds
        : [rawBuildingIds];

  if (
    buildingIds.length === 0 ||
    buildingIds.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    details.push({
      field: 'buildingIds',
      message: 'buildingIds must be a non-empty set of strings.',
    });
  }

  const periodStart = passThrough.periodStart;
  if (typeof periodStart !== 'string' || periodStart.length === 0) {
    details.push({ field: 'periodStart', message: 'periodStart is required and must be a string.' });
  }
  const periodEnd = passThrough.periodEnd;
  if (typeof periodEnd !== 'string' || periodEnd.length === 0) {
    details.push({ field: 'periodEnd', message: 'periodEnd is required and must be a string.' });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingIds: buildingIds as string[],
    periodStart: periodStart as string,
    periodEnd: periodEnd as string,
  };
}

function readUtilityConsumptionTrendRequest(
  passThrough: Record<string, unknown>,
): UtilityConsumptionTrendReadRequest {
  const details: Array<{ field: string; message: string }> = [];
  const rawBuildingIds = passThrough.buildingIds;
  const buildingIds =
    rawBuildingIds === undefined
      ? []
      : Array.isArray(rawBuildingIds)
        ? rawBuildingIds
        : [rawBuildingIds];
  if (
    buildingIds.length === 0 ||
    buildingIds.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    details.push({
      field: 'buildingIds',
      message: 'buildingIds must be a non-empty set of strings.',
    });
  }

  const periodStart = readUtilityConsumptionTrendDate(
    passThrough.periodStart,
    'periodStart',
    details,
  );
  const periodEnd = readUtilityConsumptionTrendDate(
    passThrough.periodEnd,
    'periodEnd',
    details,
  );
  const rawInterval = passThrough.interval;
  const interval =
    typeof rawInterval === 'string' && rawInterval.trim() !== ''
      ? rawInterval.trim().toUpperCase()
      : undefined;
  if (interval === undefined) {
    details.push({ field: 'interval', message: 'interval is required.' });
  }

  const rawUtilityTypes = passThrough.utilityTypes;
  let utilityTypes: UtilityType[] | undefined;
  if (rawUtilityTypes !== undefined) {
    const values = Array.isArray(rawUtilityTypes) ? rawUtilityTypes : [rawUtilityTypes];
    if (values.some((value) => typeof value !== 'string' || value.trim() === '')) {
      details.push({
        field: 'utilityTypes',
        message: 'utilityTypes must contain utility type strings.',
      });
    } else {
      utilityTypes = values.map((value) =>
        (value as string).trim().toUpperCase(),
      ) as UtilityType[];
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingIds: buildingIds as string[],
    ...(utilityTypes === undefined ? {} : { utilityTypes }),
    periodStart: periodStart!,
    periodEnd: periodEnd!,
    interval: interval as UtilityConsumptionTrendReadRequest['interval'],
  };
}

function readUtilityConsumptionTrendDate(
  value: unknown,
  field: string,
  details: Array<{ field: string; message: string }>,
): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required and must be a valid ISO-8601 date.` });
    return undefined;
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 date.` });
    return undefined;
  }
  return date;
}

type PortfolioOperationalComparisonRequest = {
  buildingIds: string[];
  periodStart: string;
  periodEnd: string;
};

function readPortfolioOperationalComparisonRequest(
  passThrough: Record<string, unknown>,
): PortfolioOperationalComparisonRequest {
  const details: Array<{ field: string; message: string }> = [];
  const supportedKeys = new Set(['buildingIds', 'periodStart', 'periodEnd']);
  for (const key of Object.keys(passThrough)) {
    if (!supportedKeys.has(key)) {
      details.push({ field: key, message: `${key} is not supported for this dataset.` });
    }
  }
  const rawBuildingIds = passThrough.buildingIds;
  const values =
    rawBuildingIds === undefined
      ? []
      : Array.isArray(rawBuildingIds)
        ? rawBuildingIds
        : [rawBuildingIds];
  const buildingIds = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  if (
    values.length === 0 ||
    buildingIds.length !== values.length ||
    buildingIds.some((value) => !isValidUuid(value))
  ) {
    details.push({
      field: 'buildingIds',
      message: 'buildingIds must be a non-empty set of valid UUIDs.',
    });
  }

  const periodStart = readPortfolioComparisonDate(passThrough.periodStart, 'periodStart', details);
  const periodEnd = readPortfolioComparisonDate(passThrough.periodEnd, 'periodEnd', details);
  if (periodStart && periodEnd && periodStart.date > periodEnd.date) {
    details.push({ field: 'periodEnd', message: 'periodEnd must be on or after periodStart.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    buildingIds: [...new Set(buildingIds)],
    periodStart: periodStart!.raw,
    periodEnd: periodEnd!.raw,
  };
}

function readPortfolioComparisonDate(
  value: unknown,
  field: string,
  details: Array<{ field: string; message: string }>,
): { raw: string; date: Date } | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required and must be a valid ISO-8601 date.` });
    return undefined;
  }
  const raw = value.trim();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 date.` });
    return undefined;
  }
  return { raw, date };
}

function portfolioComparisonDateRange(request: PortfolioOperationalComparisonRequest): {
  start: Date;
  end: Date;
} {
  const start = new Date(request.periodStart);
  const parsedEnd = new Date(request.periodEnd);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(request.periodEnd)
    ? new Date(parsedEnd.getTime() + 86400000)
    : parsedEnd;
  return { start, end };
}

function addPortfolioComparisonRows(
  counts: Map<string, Map<PortfolioOperationalComparisonMetric, number>>,
  requestedBuildingIds: ReadonlySet<string>,
  metric: PortfolioOperationalComparisonMetric,
  rows: readonly { buildingId: string }[],
): void {
  for (const row of rows) {
    if (!requestedBuildingIds.has(row.buildingId)) continue;
    const buildingCounts = counts.get(row.buildingId) ?? new Map();
    buildingCounts.set(metric, (buildingCounts.get(metric) ?? 0) + 1);
    counts.set(row.buildingId, buildingCounts);
  }
}

function buildPortfolioOperationalComparisonRows(
  request: PortfolioOperationalComparisonRequest,
  counts: Map<string, Map<PortfolioOperationalComparisonMetric, number>>,
): PublicPortfolioOperationalComparisonRow[] {
  const rows: PublicPortfolioOperationalComparisonRow[] = [];
  for (const buildingId of request.buildingIds) {
    const buildingCounts = counts.get(buildingId);
    for (const metric of PORTFOLIO_OPERATIONAL_COMPARISON_METRICS) {
      const value = buildingCounts?.get(metric);
      if (value === undefined || value === 0) continue;
      rows.push({
        buildingId,
        metric,
        value,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
      });
    }
  }
  return rows;
}

/**
 * R10 PART 03 / 04 / 05 — the `history` grains actually implemented.
 *
 * Declaring a value in OPERATIONAL_DETAIL_HISTORY_VALUES does NOT make it
 * available. Anything outside this set is rejected with an explicit validation
 * error rather than routed to a missing implementation. PART 03 implemented
 * EVIDENCE, PART 04 added FINDING_REWORK and PART 05 adds REVIEW, so this set now
 * covers the whole frozen vocabulary.
 *
 * The gate below is therefore unreachable today and is kept deliberately: it is the
 * fail-closed guard that makes "declaration is not availability" structural. If a
 * fourth value is ever added to the frozen vocabulary, it is rejected until its own
 * PART implements it, instead of silently falling through to the EVIDENCE path.
 */
const IMPLEMENTED_HISTORY_VALUES: ReadonlySet<OperationalDetailHistoryValue> =
  new Set<OperationalDetailHistoryValue>(['EVIDENCE', 'FINDING_REWORK', 'REVIEW']);

/**
 * Reads the REQUIRED `history` discriminator for OPERATIONAL_DETAIL_HISTORY.
 *
 * Normalized (trim + uppercase) and validated against the frozen vocabulary
 * declared once in reporting-export.types, following the same convention the
 * R08 child uses for its own required `engine`. Omitted, null, empty,
 * whitespace-only, repeated (array) and unknown values are ALL rejected with a
 * validation error rather than defaulted, so a grain can never be selected
 * implicitly and no competing vocabulary is declared here.
 */
/**
 * R10 PART 15 through PART 18 — the SECURITY_OPERATIONAL_DETAIL sources actually implemented.
 *
 * Declaring a value in SECURITY_OPERATIONAL_DETAIL_SOURCES does NOT make it available.
 * PART 15 implemented PATROL, PART 16 added SHIFT_HANDOVER, PART 17 added SECURITY_FINDING and
 * PART 18 adds INCIDENT_READINESS, so the frozen four-value vocabulary is now fully implemented
 * and the gate below is no longer reachable from any currently declared value.
 *
 * The gate is KEPT deliberately rather than deleted. It is the structural guarantee that
 * "declaration is not availability": were a future value added to the frozen vocabulary before its
 * owning read was wired, that value would be rejected with an explicit validation error instead of
 * falling through to another source's query or silently returning an empty result set. Deleting the
 * gate would make any next staged value implicitly available, which is exactly what PART 15 built
 * it to prevent.
 */
const IMPLEMENTED_SECURITY_OPERATIONAL_DETAIL_SOURCES: ReadonlySet<SecurityOperationalDetailSource> =
  new Set<SecurityOperationalDetailSource>([
    'PATROL',
    'SHIFT_HANDOVER',
    'SECURITY_FINDING',
    'INCIDENT_READINESS',
  ]);

/**
 * Reads the REQUIRED `source` discriminator for SECURITY_OPERATIONAL_DETAIL.
 *
 * Normalized (trim + uppercase) and validated against the frozen vocabulary declared once in
 * reporting-export.types, mirroring `readHistoryDiscriminator` exactly. Omitted, null, empty,
 * whitespace-only, repeated (array) and unknown values are ALL rejected with a validation
 * error rather than defaulted, so a source can never be selected implicitly, never inferred
 * from the filters present, and no competing vocabulary is declared here.
 */
function readSecurityOperationalDetailSource(
  value: unknown,
): SecurityOperationalDetailSource {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  if (!raw || !isSecurityOperationalDetailSource(raw)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'source',
        message: `source is required and must be one of: ${SECURITY_OPERATIONAL_DETAIL_SOURCES.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

function readHistoryDiscriminator(
  value: unknown,
): OperationalDetailHistoryValue {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  if (!raw || !isOperationalDetailHistoryValue(raw)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'history',
        message: `history is required and must be one of: ${OPERATIONAL_DETAIL_HISTORY_VALUES.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

/**
 * Reads the REQUIRED `view` discriminator for PURCHASE_ORDER_REGISTER (R11 PART 03C).
 *
 * Normalized (trim + uppercase) and validated against the frozen two-value vocabulary declared
 * once in reporting-export.types, mirroring `readSecurityOperationalDetailSource` exactly.
 * Omitted, null, empty, whitespace-only, repeated (array) and unknown values are ALL rejected
 * with a validation error rather than defaulted, so a view can never be selected implicitly
 * (there is NO default HEADER), never inferred from which filters happen to be present, and no
 * competing vocabulary is declared here.
 */
function readPurchaseOrderRegisterView(value: unknown): PurchaseOrderRegisterView {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  if (!raw || !isPurchaseOrderRegisterView(raw)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'view',
        message: `view is required and must be one of: ${PURCHASE_ORDER_REGISTER_VIEWS.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

/**
 * R11 PART 06 — the OPERATIONAL_BUDGET_VARIANCE `view` reader, mirroring
 * `readPurchaseOrderRegisterView` exactly: `view` is REQUIRED and selects exactly one
 * source-owned grain — BUDGET (one row per budget-level variance summary) or CATEGORY (one row
 * per persisted budget category of the addressed budget). A missing, empty, repeated or
 * unknown value is rejected with a validation error rather than defaulted, so a view can never
 * be selected implicitly (there is NO default BUDGET), never inferred from which filters
 * happen to be present, and no competing vocabulary is declared here.
 */
function readOperationalBudgetVarianceView(
  value: unknown,
): OperationalBudgetVarianceView {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  if (!raw || !isOperationalBudgetVarianceView(raw)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'view',
        message: `view is required and must be one of: ${OPERATIONAL_BUDGET_VARIANCE_VIEWS.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

export const REPORTING_EXPORT_DATASET_REGISTRY: Readonly<
  Record<ReportingExportDataset, ReportingExportDatasetAdapter>
> = {
  SECURITY_PATROL: {
    dataset: 'SECURITY_PATROL',
    datasetLabel: 'Security Patrol & Activity',
    sourceAuthority: 'BE-23F1 security-patrol-kpi',
    requiredReadPermission: 'security_patrol_kpi.read',
    async load(passThrough, userId) {
      const filters = parsePatrolKpiQuery(passThrough);
      const source = await securityPatrolKpiService.getSecurityPatrolKpi(
        filters,
        userId,
      );
      return {
        common: source,
        projected: projectSecurityPatrol(source),
        appliedFilters: echoFilters(filters, {
          graceMinutes: source.graceMinutes,
        }),
      };
    },
  },
  SECURITY_FINDING_INCIDENT: {
    dataset: 'SECURITY_FINDING_INCIDENT',
    datasetLabel: 'Security Finding / Incident / Handover',
    sourceAuthority: 'BE-23F2 security-finding-incident-kpi',
    requiredReadPermission: 'security_finding_incident_kpi.read',
    async load(passThrough, userId) {
      const filters = parseFindingIncidentKpiQuery(passThrough);
      const source =
        await securityFindingIncidentKpiService.getSecurityFindingIncidentKpi(
          filters,
          userId,
        );
      return {
        common: source,
        projected: projectSecurityFindingIncident(source),
        appliedFilters: echoFilters(filters),
      };
    },
  },
  WORKFORCE: {
    dataset: 'WORKFORCE',
    datasetLabel: 'Workforce',
    sourceAuthority: 'BE-23G workforce-kpi',
    requiredReadPermission: 'workforce_kpi.read',
    async load(passThrough, userId) {
      const filters = parseWorkforceKpiQuery(passThrough);
      const source = await workforceKpiService.getWorkforceKpi(filters, userId);
      return {
        common: source,
        projected: projectWorkforce(source),
        appliedFilters: echoFilters(filters, {
          graceMinutes: source.graceMinutes,
        }),
      };
    },
  },
  VENDOR_TENANT: {
    dataset: 'VENDOR_TENANT',
    datasetLabel: 'Vendor / Tenant',
    sourceAuthority: 'BE-23H vendor-tenant-kpi',
    requiredReadPermission: 'vendor_tenant_kpi.read',
    async load(passThrough, userId) {
      const filters = parseVendorTenantKpiQuery(passThrough);
      const source = await vendorTenantKpiService.getVendorTenantKpi(
        filters,
        userId,
      );
      return {
        common: source,
        projected: projectVendorTenant(source),
        appliedFilters: echoFilters(filters, {
          overdueAfterDays: source.overdueAfterDays,
        }),
      };
    },
  },
  UTILITY: {
    dataset: 'UTILITY',
    datasetLabel: 'Utility',
    sourceAuthority: 'BE-23I utility-kpi',
    requiredReadPermission: 'utility_kpi.read',
    async load(passThrough, userId) {
      const filters = parseUtilityKpiQuery(passThrough);
      const source = await utilityKpiService.getUtilityKpi(filters, userId);
      return {
        common: source,
        projected: projectUtility(source),
        appliedFilters: echoFilters(filters, {
          interval: source.interval,
          meterScope: source.meterScope,
          utilityType: source.utilityType,
        }),
      };
    },
  },
  VENDOR_SERVICE_REGISTER: {
    dataset: 'VENDOR_SERVICE_REGISTER',
    datasetLabel: 'Vendor Service Register',
    sourceAuthority: 'CR-BE-REPORT-READ-01 vendor-service-register',
    // The read contract is internal (no endpoint of its own), so the
    // archive gate reuses the closest existing vendor-reporting read
    // permission. No new permission is introduced.
    requiredReadPermission: 'vendor_tenant_kpi.read',
    async load(passThrough, userId) {
      const filters = parseVendorServiceRegisterQuery(passThrough);
      const source = await getVendorServiceRegister(filters, userId);
      return {
        common: source,
        projected: projectVendorServiceRegister(source),
        appliedFilters: echoFilters(filters),
      };
    },
  },
  FINDING_REGISTER: {
    dataset: 'FINDING_REGISTER',
    datasetLabel: 'Finding Register',
    sourceAuthority: 'CR-BE-REPORT-READ-02 finding-register',
    // The read contract is internal (service-only, no endpoint of its own).
    // Reuse the closest existing governed finding read permission
    // (`finding.read`) which already gates per-finding and
    // finding-assignment/classification/severity reads. No new permission
    // is introduced.
    requiredReadPermission: 'finding.read',
    async load(passThrough, userId) {
      const filters = parseFindingRegisterQuery(passThrough);
      const source = await getFindingRegister(filters, userId);
      return {
        common: source,
        projected: projectFindingRegister(source),
        appliedFilters: echoFilters(filters),
      };
    },
  },
  WORK_ORDER_REGISTER: {
    dataset: 'WORK_ORDER_REGISTER',
    datasetLabel: 'Work Order Register',
    sourceAuthority: 'CR-BE-REPORT-READ-03 work-order-register',
    // The read contract is internal (service-only, no endpoint of its own).
    // Reuse the closest existing governed Work Order read permission
    // (`work_order.read`) which already gates per-Work-Order reads,
    // assignments, SLA lookups, and mobile verification. No new permission
    // is introduced.
    requiredReadPermission: 'work_order.read',
    async load(passThrough, userId) {
      const filters = parseWorkOrderRegisterQuery(passThrough);
      const source = await getWorkOrderRegister(filters, userId);
      return {
        common: source,
        projected: projectWorkOrderRegister(source),
        appliedFilters: echoFilters(filters),
      };
    },
  },
  CHECKLIST_EXECUTION_SUMMARY: {
    dataset: 'CHECKLIST_EXECUTION_SUMMARY',
    datasetLabel: 'Checklist Execution Summary',
    sourceAuthority: 'CR-BE-REPORT-READ-04 checklist-execution-summary',
    // The read contract is internal (service-only, no endpoint of its own).
    // Reuse the closest existing governed checklist/form read permission
    // (`checklist.read`) which already gates per-execution reads and
    // checklist/form listing. No new permission is introduced.
    requiredReadPermission: 'checklist.read',
    async load(passThrough, userId) {
      const filters = parseChecklistExecutionSummaryQuery(passThrough);
      const source = await getChecklistExecutionSummary(filters, userId);
      return {
        common: source,
        projected: projectChecklistExecutionSummary(source),
        appliedFilters: echoFilters(filters),
      };
    },
  },
  OPERATIONAL_DETAIL: {
    dataset: 'OPERATIONAL_DETAIL',
    datasetLabel: 'Operational Detail',
    sourceAuthority: 'R07 operational-detail-reporting',
    // The read contract is internal (service-only, no endpoint of its own).
    // Reuse the closest existing governed checklist/form read permission
    // (`checklist.read`) which already gates per-execution reads and
    // checklist/form listing and is used by CHECKLIST_EXECUTION_SUMMARY.
    // No new permission is introduced.
    requiredReadPermission: 'checklist.read',
    async load(passThrough, userId) {
      // Parse with neutral query parser — validates engine, buildingId, executionId, templateId, status, dateFrom/dateTo, limit/offset
      const parsed = parseOperationalDetailQuery(passThrough);

      // ENGINE IS REQUIRED — no default, no BOTH, no omitted
      if (!parsed.engine) {
        throw AppError.validation('Request validation failed.', [
          { field: 'engine', message: 'engine is required (CHECKLIST_EXECUTION | FORM_INSTANCE).' },
        ]);
      }

      // Ignore user-supplied limit/offset for export — internal batching owns pagination
      // Extract only governed filters
      const { limit: _ignoredLimit, offset: _ignoredOffset, ...governedFilters } = parsed as Record<string, unknown>;

      // FIXED EXPORT UPPER BOUND — freeze once at load start
      // If caller supplied dateTo, reuse exact validated upper bound every page
      // If not, freeze one timestamp once and use consistently as dateTo for every page
      const frozenNowIso = new Date().toISOString();
      const effectiveDateTo = (parsed as { dateTo?: string }).dateTo ?? frozenNowIso;

      // Build base filters with effective dateTo frozen across pages
      const baseFilters = {
        ...governedFilters,
        dateTo: effectiveDateTo,
      } as typeof parsed;

      const INTERNAL_BATCH_SIZE = 1000;
      let offset = 0;
      let allRows: import('../operational-detail-reporting').PublicOperationalDetailRow[] = [];
      let firstSource: import('../operational-detail-reporting').PublicOperationalDetail | null = null;

      // Internal paging loop for single selected engine — no cross-engine pagination
      while (true) {
        const pageFilters = {
          ...baseFilters,
          limit: INTERNAL_BATCH_SIZE,
          offset,
        };

        const source = await getOperationalDetail(pageFilters, userId);

        if (!firstSource) {
          firstSource = source;
        }

        allRows = allRows.concat(source.rows);

        if (source.rows.length < INTERNAL_BATCH_SIZE) {
          break;
        }
        offset += INTERNAL_BATCH_SIZE;
      }

      // If no rows and no accessible buildings, firstSource may be empty result from service
      // Ensure we have a source for common envelope
      const commonSource = firstSource ?? {
        buildingId: (baseFilters as { buildingId?: string }).buildingId ?? null,
        buildingScope: [],
        dateFrom: (baseFilters as { dateFrom?: string }).dateFrom ?? null,
        dateTo: effectiveDateTo,
        asOf: new Date().toISOString(),
        engine: baseFilters.engine ?? null,
        rows: [],
      };

      // Use accumulated rows as the full export source
      const fullSource = {
        ...commonSource,
        rows: allRows,
        dateTo: effectiveDateTo, // ensure effective dateTo frozen across pages
      };

      // Applied filters — echo governed filters plus effective dateTo
      // Spec: echo engine buildingId executionId templateId status dateFrom effective dateTo include frozen if generated
      const applied = echoFilters({
        ...governedFilters,
        dateTo: effectiveDateTo,
      } as Record<string, unknown>);

      return {
        common: {
          buildingId: commonSource.buildingId,
          buildingScope: commonSource.buildingScope,
          dateFrom: commonSource.dateFrom,
          dateTo: effectiveDateTo,
          asOf: commonSource.asOf,
        },
        projected: projectOperationalDetail(fullSource as import('../operational-detail-reporting').PublicOperationalDetail),
        appliedFilters: applied,
      };
    },
  },
  MANAGEMENT_OPERATIONS_COMMAND_CENTER: {
    dataset: 'MANAGEMENT_OPERATIONS_COMMAND_CENTER',
    datasetLabel: 'Management Operations Command Center',
    sourceAuthority: 'BE-24 management-operations-command-center',
    requiredReadPermission: 'management_read_model.read',
    async load(passThrough, userId) {
      const filters = parseManagementOperationsCommandCenterQuery(passThrough);
      const source =
        await managementOperationsCommandCenterService.getManagementOperationsCommandCenter(
          filters,
          userId,
        );
      const projected = projectManagementOperationsCommandCenter(source);
      return {
        common: {
          buildingId:
            source.scope.buildingIds.length === 1
              ? source.scope.buildingIds[0]!
              : null,
          buildingScope: source.scope.buildingIds,
          dateFrom: source.period.dateFrom,
          dateTo: source.period.dateTo,
          asOf: source.asOf,
        },
        projected,
        appliedFilters: echoFilters({ ...source.filters }),
      };
    },
  },
  CORRECTIVE_ACTION: {
    dataset: 'CORRECTIVE_ACTION',
    datasetLabel: 'Corrective Action',
    sourceAuthority: 'BE-21G corrective-actions',
    // Reuses the permission that already gates GET /corrective-actions
    // (`requirePermission('corrective_action.read')`). No new permission is
    // introduced and no second access path is created: building access is
    // resolved entirely inside the owning service.
    requiredReadPermission: 'corrective_action.read',
    async load(passThrough, userId) {
      // The owning domain's own filter parser and read are reused verbatim, so
      // filters, lifecycle state, incident lineage, scope and due semantics all
      // stay authoritative there. No new SQL and no second read model.
      const filters = parseCorrectiveActionFilters(passThrough);
      // The owning service derives due state at ONE instant for the whole page
      // and does not publish that instant, so `asOf` is captured immediately
      // before the call. It is the export envelope instant only and must never
      // be used to re-derive dueState/isOverdue — both are copied verbatim from
      // the domain's own `dueStatus` projection.
      const asOf = new Date().toISOString();
      const rows = await listCorrectiveActions(filters, userId);
      return {
        common: {
          // Null for a multi-building rollup, matching the register datasets. A
          // supplied buildingId is the one the owning service already
          // existence/access-checked.
          buildingId: filters.buildingId ?? null,
          // The owning read publishes rows, not a scope list, so the scope is
          // the distinct set of Buildings actually represented in those
          // authoritative rows. That is a pure projection of a fact the domain
          // already resolved read-only through the parent Incident — not a
          // second access path and not an inference from any unrelated record.
          buildingScope: [...new Set(rows.map((row) => row.buildingId))].sort(),
          // CorrectiveActionFilters has no report date window. `dueBefore` /
          // `dueAfter` bound the DUE DATE, not a period, so the envelope period
          // stays null rather than reinterpreting them.
          dateFrom: null,
          dateTo: null,
          asOf,
        },
        projected: projectCorrectiveAction(rows),
        // `echoFilters` keeps only string/number/boolean values, so the two
        // Date-valued due-date bounds are echoed explicitly as ISO strings.
        // Only filters the authoritative parser actually accepts are echoed;
        // none is invented and none is reinterpreted.
        appliedFilters: echoFilters(filters, {
          ...(filters.dueBefore
            ? { dueBefore: filters.dueBefore.toISOString() }
            : {}),
          ...(filters.dueAfter ? { dueAfter: filters.dueAfter.toISOString() } : {}),
        }),
      };
    },
  },
  OPERATIONAL_DETAIL_HISTORY: {
    dataset: 'OPERATIONAL_DETAIL_HISTORY',
    datasetLabel: 'Operational Detail History',
    sourceAuthority: 'R08 operational-detail child histories',
    // Same authority as OPERATIONAL_DETAIL: the closest existing governed
    // checklist/form read permission, which already gates per-execution reads
    // and checklist/form listing. No new permission is introduced.
    requiredReadPermission: 'checklist.read',
    async load(passThrough, userId) {
      // `history` is REQUIRED and selects exactly one R08 child grain.
      const history = readHistoryDiscriminator(passThrough.history);
      if (!IMPLEMENTED_HISTORY_VALUES.has(history)) {
        throw AppError.validation('Request validation failed.', [
          {
            field: 'history',
            message: `history ${history} is not implemented yet; supported: ${[
              ...IMPLEMENTED_HISTORY_VALUES,
            ].join(', ')}.`,
          },
        ]);
      }

      // FIXED EXPORT UPPER BOUND — the clock is read ONCE for the whole load and
      // reused for every page of whichever grain is selected, so rows created
      // mid-export cannot shift the window and cause a duplicate or a skip. Both
      // R08 children apply dateFrom/dateTo to the PARENT EXECUTION's created_at
      // with half-open [start, end) semantics.
      const frozenNowIso = new Date().toISOString();

      // REVIEW grain (R10 PART 05) — the EXISTING R08 execution review-history
      // child owns the parser, the required `engine` contract, every filter,
      // fail-closed scope resolution and the row shape. No new review SQL, no
      // second review read model and no competing engine, status or decision
      // vocabulary: the child reuses the R07 engine authority and the shared
      // reviews REVIEW_DECISIONS authority directly. GRAIN is ONE row per
      // `reviews.id` — this is FULL history, so it is never narrowed to the latest
      // review or to COMPLETED-only, PENDING rows and NULL decisions stay visible,
      // and no sibling child is joined. The child binds `reviews.target_type` to an
      // R07 engine literal, so the other shared review targets stay structurally
      // unreachable and this adapter never widens that predicate.
      if (history === 'REVIEW') {
        const parsed = parseOperationalDetailReviewHistoryQuery(passThrough);

        // Caller pagination is NOT export business semantics — strip it and let
        // internal batching own paging, following the established PART 03 pattern.
        const {
          limit: _ignoredLimit,
          offset: _ignoredOffset,
          ...governedFilters
        } = parsed;

        // Reuses the single frozen clock read above — no second clock is started
        // for this grain, so every branch of one load shares one upper bound.
        const effectiveDateTo = governedFilters.dateTo ?? frozenNowIso;
        const baseFilters = { ...governedFilters, dateTo: effectiveDateTo };

        // The child caps limit at its own MAX_LIMIT of 1000, so this page size is
        // the largest single request it will honour and a short page is the
        // authoritative end-of-results signal. Its ORDER BY is deterministic
        // (target_id, created_at DESC, review id), so stable paging neither
        // duplicates nor omits a review.
        const INTERNAL_BATCH_SIZE = 1000;
        let offset = 0;
        let allRows: PublicOperationalDetailReviewHistoryRow[] = [];
        let firstSource: PublicOperationalDetailReviewHistory | null = null;

        while (true) {
          const source = await getOperationalDetailReviewHistory(
            { ...baseFilters, limit: INTERNAL_BATCH_SIZE, offset },
            userId,
          );
          if (!firstSource) firstSource = source;
          allRows = allRows.concat(source.rows);
          if (source.rows.length < INTERNAL_BATCH_SIZE) break;
          offset += INTERNAL_BATCH_SIZE;
        }

        // A fail-closed empty authorized scope still yields a well-formed source,
        // so this fallback only covers the no-page-returned case.
        const commonSource = firstSource ?? {
          engine: parsed.engine,
          buildingId: governedFilters.buildingId ?? null,
          buildingScope: [],
          dateFrom: governedFilters.dateFrom ?? null,
          dateTo: effectiveDateTo,
          asOf: frozenNowIso,
          rows: [],
        };
        const fullSource: PublicOperationalDetailReviewHistory = {
          ...commonSource,
          rows: allRows,
          // Keep the frozen upper bound across every page.
          dateTo: effectiveDateTo,
        };

        return {
          common: {
            buildingId: commonSource.buildingId,
            buildingScope: commonSource.buildingScope,
            dateFrom: commonSource.dateFrom,
            dateTo: effectiveDateTo,
            asOf: commonSource.asOf,
          },
          projected: projectOperationalDetailReviewHistory(fullSource),
          // Echo only filters actually applied: the governed child filters (with
          // the frozen dateTo) plus the discriminator that selected this grain.
          // Stripped limit/offset are never echoed as business filters.
          appliedFilters: echoFilters(
            { ...governedFilters, dateTo: effectiveDateTo },
            { history },
          ),
        };
      }

      // FINDING_REWORK grain (R10 PART 04) — the EXISTING R08 finding-rework
      // child owns the parser, the required `engine` contract, every filter,
      // fail-closed scope resolution and the row shape. No new cycle SQL, no
      // second read authority and no competing engine vocabulary: `engine` is
      // required by the child itself with no default, no BOTH and no omission,
      // and it throws before this adapter proceeds. GRAIN is ONE row per
      // `finding_rework_cycles.id` — cycles are never collapsed, aggregated or
      // deduplicated by findingId, and no sibling child is joined.
      if (history === 'FINDING_REWORK') {
        const parsed = parseOperationalDetailFindingReworkQuery(passThrough);

        // Caller pagination is NOT export business semantics — strip it and let
        // internal batching own paging, following the established PART 03 pattern.
        const {
          limit: _ignoredLimit,
          offset: _ignoredOffset,
          ...governedFilters
        } = parsed;

        const effectiveDateTo = governedFilters.dateTo ?? frozenNowIso;
        const baseFilters = { ...governedFilters, dateTo: effectiveDateTo };

        // The child caps limit at its own MAX_LIMIT of 1000, so this page size is
        // the largest single request it will honour and a short page is the
        // authoritative end-of-results signal. Its ORDER BY is deterministic
        // (source_id, finding id, requested_at, cycle id), so stable paging
        // neither duplicates nor omits a cycle.
        const INTERNAL_BATCH_SIZE = 1000;
        let offset = 0;
        let allRows: PublicOperationalDetailFindingReworkRow[] = [];
        let firstSource: PublicOperationalDetailFindingRework | null = null;

        while (true) {
          const source = await getOperationalDetailFindingRework(
            { ...baseFilters, limit: INTERNAL_BATCH_SIZE, offset },
            userId,
          );
          if (!firstSource) firstSource = source;
          allRows = allRows.concat(source.rows);
          if (source.rows.length < INTERNAL_BATCH_SIZE) break;
          offset += INTERNAL_BATCH_SIZE;
        }

        // A fail-closed empty authorized scope still yields a well-formed source,
        // so this fallback only covers the no-page-returned case.
        const commonSource = firstSource ?? {
          engine: parsed.engine,
          buildingId: governedFilters.buildingId ?? null,
          buildingScope: [],
          dateFrom: governedFilters.dateFrom ?? null,
          dateTo: effectiveDateTo,
          asOf: frozenNowIso,
          rows: [],
        };
        const fullSource: PublicOperationalDetailFindingRework = {
          ...commonSource,
          rows: allRows,
          // Keep the frozen upper bound across every page.
          dateTo: effectiveDateTo,
        };

        return {
          common: {
            buildingId: commonSource.buildingId,
            buildingScope: commonSource.buildingScope,
            dateFrom: commonSource.dateFrom,
            dateTo: effectiveDateTo,
            asOf: commonSource.asOf,
          },
          projected: projectOperationalDetailFindingRework(fullSource),
          // Echo only filters actually applied: the governed child filters (with
          // the frozen dateTo) plus the discriminator that selected this grain.
          // Stripped limit/offset are never echoed as business filters.
          appliedFilters: echoFilters(
            { ...governedFilters, dateTo: effectiveDateTo },
            { history },
          ),
        };
      }

      // EVIDENCE grain (R10 PART 03, unchanged) — the EXISTING R08 child owns the
      // parser, the required `engine` contract, every filter, scope resolution and
      // the row shape. No new evidence SQL, no second read authority, and no
      // competing engine vocabulary: `engine` is required by the child itself with
      // no default, no BOTH and no omission, and it throws before this adapter
      // proceeds. This is the fall-through because REVIEW and FINDING_REWORK both
      // returned above, so EVIDENCE is the only remaining implemented grain.
      const parsed = parseOperationalDetailEvidenceQuery(passThrough);

      // Caller pagination is NOT export business semantics — strip it and let
      // internal batching own paging, exactly as OPERATIONAL_DETAIL does.
      const {
        limit: _ignoredLimit,
        offset: _ignoredOffset,
        ...governedFilters
      } = parsed;

      // The frozen upper bound is reused for every page, so rows created
      // mid-export cannot shift the window and cause a duplicate or a skip.
      const effectiveDateTo = governedFilters.dateTo ?? frozenNowIso;
      const baseFilters = { ...governedFilters, dateTo: effectiveDateTo };

      // The child caps limit at its own MAX_LIMIT of 1000, so this page size is
      // the largest single request it will honour and a short page is the
      // authoritative end-of-results signal.
      const INTERNAL_BATCH_SIZE = 1000;
      let offset = 0;
      let allRows: PublicOperationalDetailEvidenceRow[] = [];
      let firstSource: PublicOperationalDetailEvidence | null = null;

      while (true) {
        const source = await getOperationalDetailEvidence(
          { ...baseFilters, limit: INTERNAL_BATCH_SIZE, offset },
          userId,
        );
        if (!firstSource) firstSource = source;
        allRows = allRows.concat(source.rows);
        if (source.rows.length < INTERNAL_BATCH_SIZE) break;
        offset += INTERNAL_BATCH_SIZE;
      }

      // A fail-closed empty authorized scope still yields a well-formed source,
      // so this fallback only covers the no-page-returned case.
      const commonSource = firstSource ?? {
        engine: parsed.engine,
        buildingId: governedFilters.buildingId ?? null,
        buildingScope: [],
        dateFrom: governedFilters.dateFrom ?? null,
        dateTo: effectiveDateTo,
        asOf: frozenNowIso,
        rows: [],
      };
      const fullSource: PublicOperationalDetailEvidence = {
        ...commonSource,
        rows: allRows,
        // Keep the frozen upper bound across every page.
        dateTo: effectiveDateTo,
      };

      return {
        common: {
          buildingId: commonSource.buildingId,
          buildingScope: commonSource.buildingScope,
          dateFrom: commonSource.dateFrom,
          dateTo: effectiveDateTo,
          asOf: commonSource.asOf,
        },
        projected: projectOperationalDetailEvidence(fullSource),
        // Echo only filters actually applied: the governed child filters (with
        // the frozen dateTo) plus the discriminator that selected this grain.
        // Stripped limit/offset are never echoed as business filters.
        appliedFilters: echoFilters(
          { ...governedFilters, dateTo: effectiveDateTo },
          { history },
        ),
      };
    },
  },

  WORK_ORDER_SLA: {
    dataset: 'WORK_ORDER_SLA',
    datasetLabel: 'Work Order SLA',
    sourceAuthority: 'R10 work-order-sla-register',
    // R10 PART 08 — the enforcement point for this export is the EXISTING
    // `work_order.read`, the same governed Work Order read permission the
    // WORK_ORDER_REGISTER adapter and the SLA domain's own routes already use.
    // No new permission, no reporting.read, no sla.read and no admin fallback.
    requiredReadPermission: 'work_order.read',
    async load(passThrough, userId) {
      // Parsing, validation, fail-closed Building-scope resolution, the frozen
      // `asOf` instant and the row read ALL stay with the owning register: this
      // adapter adds presentation only. The repository is never imported here and
      // no SLA, clock, pause or escalation table is queried from Reporting.
      const filters = parseWorkOrderSlaRegisterQuery(passThrough);
      const source = await getWorkOrderSlaRegister(filters, userId);
      return {
        // The register's own envelope is forwarded whole, so `buildingScope` is the
        // scope the service actually authorized (never derived from the rows) and
        // `asOf` is the service's single frozen instant (Reporting reads no clock
        // of its own and recomputes no current-only value).
        common: source,
        // ONE table `workOrderSla` at ONE row per SLA clock: a Work Order may
        // legitimately appear twice, RESPONSE and RESOLUTION, and the two clocks are
        // never collapsed. No KPI is calculated.
        projected: projectWorkOrderSla(source),
        // Echo only the filters the register actually parsed and applied. Its date
        // window is over `applied_slas.applied_at`, so dateFrom/dateTo are echoed as
        // that applied-SLA period and never reinterpreted as a breachedAt, startedAt,
        // satisfiedAt or escalation period.
        appliedFilters: echoFilters(filters),
      };
    },
  },

  SCHEDULED_OPERATION_LINEAGE: {
    dataset: 'SCHEDULED_OPERATION_LINEAGE',
    datasetLabel: 'Scheduled Operation Lineage',
    sourceAuthority: 'R10 scheduled-operation-lineage',
    // R10 PART 11 — the enforcement point for this export is the EXISTING `task.read`,
    // source-verified in PART 10: `task.routes` gates GET /tasks and GET /tasks/:id over
    // `generated_tasks` (this dataset's base row authority and grain) with it, and
    // `mobile-assignments` already reads generated tasks under it. No new permission, no
    // `schedule.read` (that governs the schedule-definition read model and the scheduler's
    // occurrence preview, which are enrichment here rather than the returned rows), no
    // `reporting.read` and no admin fallback.
    requiredReadPermission: 'task.read',
    async load(passThrough, userId) {
      // Parsing, validation, fail-closed Building-scope resolution, date-window
      // normalization and the row read ALL stay with the owning module: this adapter adds
      // presentation only. Its repository is never imported here, and no generated-task,
      // schedule, recurrence, assignment or execution-binding table is queried from
      // Reporting.
      const filters = parseScheduledOperationLineageQuery(passThrough);
      const source = await getScheduledOperationLineage(filters, userId);
      return {
        // The service's own envelope is forwarded whole, so `buildingScope` is the scope
        // the service actually authorized (never derived from the rows and never widened
        // to client-only or NULL-building tasks) and `asOf` is the service's single
        // instant. For this dataset `asOf` is envelope metadata only: nothing here reads a
        // clock or derives a missed/overdue value from it.
        common: source,
        // ONE table `scheduledOperationLineage` at ONE row per `generated_tasks.id`: a
        // schedule legitimately contributes many rows, one per generated occurrence, and
        // they are never collapsed. No KPI is calculated.
        projected: projectScheduledOperationLineage(source),
        // Echo only the filters the module actually parsed and applied — exactly its
        // eleven. Its date window is over `generated_tasks.occurrence_at`, so
        // dateFrom/dateTo are echoed as that occurrence period and never reinterpreted as
        // createdAt, generatedAt, completedAt, assignment time or recurrence start/end.
        appliedFilters: echoFilters(filters),
      };
    },
  },
  PERMIT_TO_WORK: {
    dataset: 'PERMIT_TO_WORK',
    datasetLabel: 'Permit To Work',
    sourceAuthority: 'R10 permit-to-work-register',
    // R10 PART 14 — the enforcement point is the EXISTING `permit.read`, the permission the
    // owning register service already resolves Building scope under. Deliberately NOT
    // `permit.manage` or `permit.approve`: those are write and decision authorities, and
    // gating a read export on them would narrow it to actors who can change permits. NOT
    // `reporting.read` and NOT an admin fallback either. No new permission is introduced.
    requiredReadPermission: 'permit.read',
    async load(passThrough, userId) {
      // Parsing, the REQUIRED `view` discriminator, fail-closed Building-scope resolution,
      // date-window normalization and the row read ALL stay with the owning module: this
      // adapter adds presentation only. `view` has no default and is never inferred from
      // which filters happen to be present; no second lowercase parser and no duplicate
      // validation is created here; and a filter belonging to the other view is never
      // silently stripped, because the owning parser rejects it. The owning repository is
      // never imported, and no permit, application, approval-binding, validity or
      // work-lifecycle table is queried from Reporting.
      const parsed = parsePermitToWorkRegisterQuery(passThrough);
      const source = await getPermitToWorkRegister(parsed, userId);
      return {
        // The service's own view-discriminated envelope is forwarded whole, so
        // `buildingScope` is the scope the service actually authorized (never derived from
        // the returned rows and never widened) and `asOf`, `dateFrom` and `dateTo` are the
        // register's own single clock and window. For this dataset `asOf` is envelope
        // metadata only: nothing here reads a clock, and neither `new Date()` nor
        // `Date.now()` appears in this adapter.
        common: source,
        // Presentation branch ONLY, on `source.view`. The service has already selected the
        // grain and validated the discriminator, so nothing is re-decided here. Each view
        // yields exactly ONE table (`permitToWorkLifecycle` or `permitToWorkApproval`) and
        // never both, never an empty second table, and never a universal permit row merging
        // the two grains: LIFECYCLE is one row per `permit_applications.id` while APPROVAL
        // is one row per `permit_approval_bindings.id`, a true 1:N child whose rows are
        // never collapsed back onto the application. The narrowing is exhaustive over the
        // frozen two-member union, so if a third view were ever added upstream the false
        // branch would stop type-checking instead of silently routing to the approval
        // table. Neither view carries a headline figure, so both are `kpis: []`.
        projected:
          source.view === 'LIFECYCLE'
            ? projectPermitToWorkLifecycle(source)
            : projectPermitToWorkApproval(source),
        // Echo the required `view` plus only the filters the owning parser actually accepted
        // and applied — seven for LIFECYCLE, thirteen for APPROVAL, every one scalar. Its
        // date window is over `permit_applications.requested_work_at` for LIFECYCLE and over
        // `permit_approval_bindings.created_at` for APPROVAL, so dateFrom/dateTo are echoed
        // as that view's own authority and never reinterpreted as submittedAt, cancelledAt,
        // reviewedAt, validFrom or validUntil.
        appliedFilters: echoFilters(parsed.filters, { view: parsed.view }),
      };
    },
  },

  SECURITY_OPERATIONAL_DETAIL: {
    dataset: 'SECURITY_OPERATIONAL_DETAIL',
    datasetLabel: 'Security Operational Detail',
    // R10 PART 16 through PART 18 — ONE dataset with source-dependent grains, never one dataset
    // enum per source. Each implemented source is a pure adapter over its OWN existing governed
    // BE-12M read.
    sourceAuthority:
      'BE-12M security-reports patrol, shift-handover, security-finding and incident-readiness datasets',
    // R10 PART 15 — the enforcement point is the EXISTING `security_report.read`, source-verified
    // as the permission that already gates every GET /security/reports/* endpoint in
    // `security-report.routes`, including /security/reports/shift-handovers,
    // /security/reports/findings and /security/reports/incident-readiness. No new permission is
    // introduced, and no generic security.read, finding.read, incident.read, task.read,
    // reporting.read or admin fallback is substituted. PART 16, PART 17 and PART 18 reuse it
    // unchanged.
    requiredReadPermission: 'security_report.read',
    async load(passThrough, userId) {
      // `source` is REQUIRED and selects exactly one Security operational grain. PART 15
      // implemented PATROL, PART 16 added SHIFT_HANDOVER, PART 17 added SECURITY_FINDING and
      // PART 18 adds INCIDENT_READINESS; any value staged into the frozen vocabulary later still
      // fails closed above rather than routing here.
      const source = readSecurityOperationalDetailSource(passThrough.source);
      if (!IMPLEMENTED_SECURITY_OPERATIONAL_DETAIL_SOURCES.has(source)) {
        throw AppError.validation('Request validation failed.', [
          {
            field: 'source',
            message: `source ${source} is not implemented yet; supported: ${[
              ...IMPLEMENTED_SECURITY_OPERATIONAL_DETAIL_SOURCES,
            ].join(', ')}.`,
          },
        ]);
      }

      // ------------------------------------------------------------------
      // R10 PART 16 — source=SHIFT_HANDOVER
      //
      // A pure adapter over the EXISTING governed shift-handover dataset read. Filter parsing,
      // Building-existence and access assertion, period normalization and the row read ALL stay
      // with the owning BE-12M module: no shift-handover SQL, no second read model, and neither
      // `security_shift_handover_bindings` nor `shift_handovers` is ever queried from Reporting.
      //
      // The branch is self-contained so the PART 15 PATROL path below remains textually and
      // behaviourally untouched, and because the two sources genuinely differ — their parse
      // contracts, period columns, grains and table keys are not the same, so each is documented
      // against its own owning read rather than merged into shared prose.
      // ------------------------------------------------------------------
      if (source === 'SHIFT_HANDOVER') {
        // The owning shift-handover endpoint validates `status` against the security module's own
        // published HANDOVER_REPORT_STATUSES, so that allow-list is reused verbatim: an unknown
        // status is a validation error rather than a silently empty register. Reporting declares
        // no competing vocabulary. (PATROL below keeps PART 15's exact parse call because the
        // owning index does not re-export that source's status vocabulary.)
        const filters = parseReportQuery(passThrough, {
          allowedStatuses: HANDOVER_REPORT_STATUSES,
        });

        // buildingId is REQUIRED for this dataset, exactly as for PATROL. The owning parser leaves
        // it optional because the security SUMMARY endpoint may roll up across every accessible
        // Building; asserting presence here keeps the documented dataset contract and structurally
        // prevents the roll-up path, so this export can never widen to Buildings the caller did
        // not ask for. Presence only — the owning parser remains the authority on UUID format.
        if (!filters.buildingId) {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'buildingId',
              message: `buildingId is required for source=${source}.`,
            },
          ]);
        }

        // The owning shift-handover read publishes rows, not an envelope, and publishes no instant,
        // so `asOf` is captured immediately before the call — the SAME envelope-only convention
        // PART 15 established for PATROL, and the only Reporting clock in this path. It is export
        // envelope metadata: no row is classified against it, and no completed, accepted,
        // acknowledged, overdue, missed, pending or late value is derived from it.
        const asOf = new Date().toISOString();
        const rows = await securityReportService.getShiftHandoverDataset(
          filters,
          userId,
        );
        return {
          common: {
            buildingId: filters.buildingId,
            // Exactly the scope the owning service used: with a buildingId present its
            // `resolveBuildingScope` returns `[buildingId]` and nothing else, and it short-circuits
            // to zero rows when the accessible scope is empty. The scope is taken from the
            // authorized filter, never derived from the returned rows and never widened.
            buildingScope: [filters.buildingId],
            // The owning parser's own normalized period, echoed unchanged. Its semantics belong to
            // BE-12M: this read bounds on the shift handover's own `created_at` with a half-open
            // range (`>= start`, `< end`) and orders by `sh.created_at DESC, sshb.created_at DESC`.
            // Reporting creates no second interpretation of it and no new date mode.
            dateFrom: filters.dateFrom ?? null,
            dateTo: filters.dateTo ?? null,
            asOf,
          },
          // ONE table `securityOperationalShiftHandover` at ONE row per governed shift-handover
          // dataset row. The row identity is the binding's own `bindingId`, copied verbatim;
          // `shiftHandoverId` is a related fact that may legitimately repeat across several
          // bindings and is preserved as several rows — never collapsed, deduplicated, or elected
          // as the latest, current, most recent, active or effective handover. No KPI is calculated
          // and no acknowledgement outcome is derived from either persisted status.
          projected: projectSecurityOperationalShiftHandover(rows),
          // Echo the required `source` plus only the filters the owning parser actually accepted.
          // For SHIFT_HANDOVER the owning read applies buildingId (on the binding's own building),
          // securityPostId (direct equality on the binding's start post — NOT the patrol COALESCE
          // form), patrolRouteId, status (the HANDOVER status, `sh.status`), dateFrom and dateTo;
          // any other parsed field is ignored by that read exactly as the existing dataset
          // endpoint ignores it, and none is reinterpreted here.
          appliedFilters: echoFilters(filters, { source }),
        };
      }

      // ------------------------------------------------------------------
      // R10 PART 17 — source=SECURITY_FINDING
      //
      // A pure adapter over the EXISTING governed security-finding dataset read. Filter parsing,
      // Building-existence and access assertion, period normalization and the row read ALL stay
      // with the owning BE-12M module: no finding SQL, no second finding authority, and neither
      // `security_finding_links` nor `findings` is ever queried from Reporting. This is NOT the
      // R08 Finding child grain and NOT the FINDING_REGISTER dataset; nothing is joined to or
      // merged with either and no row is enriched.
      //
      // The branch is self-contained, matching the PART 16 SHIFT_HANDOVER branch, so the two
      // earlier source paths remain textually and behaviourally untouched. The three sources
      // genuinely differ — parse vocabulary, period column, security-post filter form, grain and
      // table key — so each documents its own owning read rather than sharing prose.
      // ------------------------------------------------------------------
      if (source === 'SECURITY_FINDING') {
        // The owning findings endpoint validates `status` against the security module's own
        // published FINDING_REPORT_STATUSES, so that allow-list is reused verbatim: an unknown
        // status is a validation error rather than a silently empty register. Reporting declares
        // no competing finding status or severity vocabulary of its own.
        const filters = parseReportQuery(passThrough, {
          allowedStatuses: FINDING_REPORT_STATUSES,
        });

        // buildingId is REQUIRED for this dataset, exactly as for PATROL and SHIFT_HANDOVER. The
        // owning parser leaves it optional because the security SUMMARY endpoint may roll up
        // across every accessible Building; asserting presence here keeps the documented dataset
        // contract and structurally prevents the roll-up path, so this export can never widen to
        // Buildings the caller did not ask for. Presence only — the owning parser remains the
        // authority on UUID format.
        if (!filters.buildingId) {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'buildingId',
              message: `buildingId is required for source=${source}.`,
            },
          ]);
        }

        // The owning security-finding read publishes rows, not an envelope, and publishes no
        // instant, so `asOf` is captured immediately before the call — the SAME envelope-only
        // convention PART 15 established and PART 16 reused, and the only Reporting clock in this
        // path. It is export envelope metadata: no row is classified against it, and no SLA,
        // overdue, age, timeOpen, breach, open, closed or resolved value is derived from it or
        // from `reportedAt`.
        const asOf = new Date().toISOString();
        const rows = await securityReportService.getSecurityFindingDataset(
          filters,
          userId,
        );
        return {
          common: {
            buildingId: filters.buildingId,
            // Exactly the scope the owning service used: with a buildingId present its
            // `resolveBuildingScope` returns `[buildingId]` and nothing else, and it short-circuits
            // to zero rows when the accessible scope is empty. The scope is taken from the
            // authorized filter, never derived from the returned rows and never widened.
            buildingScope: [filters.buildingId],
            // The owning parser's own normalized period, echoed unchanged. Its semantics belong to
            // BE-12M: this read bounds on the FINDING's own `reported_at` with a half-open range
            // (`>= start`, `< end`) and orders by `f.reported_at DESC, sfl.created_at DESC`.
            // Reporting creates no second interpretation of it and no new date mode.
            dateFrom: filters.dateFrom ?? null,
            dateTo: filters.dateTo ?? null,
            asOf,
          },
          // ONE table `securityOperationalFinding` at ONE row per governed security-finding dataset
          // row. The row identity is the link's own `linkId`, copied verbatim; `findingId` is a
          // related fact that may legitimately repeat across several links and is preserved as
          // several rows — never collapsed, deduplicated, or elected as the latest, current or
          // active finding. No KPI is calculated, and neither `findingStatus` nor the constant
          // `linkStatus` the owning read publishes is turned into an SLA or ageing outcome.
          projected: projectSecurityOperationalFinding(rows),
          // Echo the required `source` plus only the filters the owning parser actually accepted.
          // For SECURITY_FINDING the owning read applies buildingId (on the link's own building),
          // status (the FINDING status, `f.status`), securityPostId (direct equality on the link's
          // start post — NOT the patrol COALESCE form), patrolRouteId, dateFrom and dateTo; any
          // other parsed field is ignored by that read exactly as the existing dataset endpoint
          // ignores it, and none is reinterpreted here.
          appliedFilters: echoFilters(filters, { source }),
        };
      }

      // ------------------------------------------------------------------
      // R10 PART 18 — source=INCIDENT_READINESS
      //
      // A pure adapter over the EXISTING governed incident-readiness dataset read. Building
      // existence and access assertion plus the row read ALL stay with the owning BE-12M module:
      // no readiness SQL, no second incident-readiness authority, and
      // `security_incident_readiness` is never queried from Reporting.
      //
      // The branch is self-contained, matching the PART 16 and PART 17 branches, so the three
      // earlier source paths remain textually and behaviourally untouched. This source differs
      // from all three in one material way — its owning read applies NO period bound — so it is
      // documented against its own read rather than folded into shared prose.
      // ------------------------------------------------------------------
      if (source === 'INCIDENT_READINESS') {
        // The owning incident-readiness endpoint validates `status` against the security module's
        // own published INCIDENT_READINESS_REPORT_STATUSES, so that allow-list is reused verbatim:
        // an unknown status is a validation error rather than a silently empty register. Reporting
        // declares no competing readiness or category vocabulary of its own.
        const filters = parseReportQuery(passThrough, {
          allowedStatuses: INCIDENT_READINESS_REPORT_STATUSES,
        });

        // buildingId is REQUIRED for this dataset, exactly as for the other three sources. The
        // owning parser leaves it optional because the security SUMMARY endpoint may roll up
        // across every accessible Building; asserting presence here keeps the documented dataset
        // contract and structurally prevents the roll-up path, so this export can never widen to
        // Buildings the caller did not ask for. Presence only — the owning parser remains the
        // authority on UUID format.
        if (!filters.buildingId) {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'buildingId',
              message: `buildingId is required for source=${source}.`,
            },
          ]);
        }

        // The owning incident-readiness read publishes rows, not an envelope, and publishes no
        // instant, so `asOf` is captured immediately before the call — the SAME envelope-only
        // convention PART 15 established and PART 16 and PART 17 reused, and the only Reporting
        // clock in this path. It is export envelope metadata: no row is classified against it, and
        // no readiness, SLA, overdue, age or stale value is derived from it or from `updatedAt`.
        const asOf = new Date().toISOString();
        const rows =
          await securityReportService.getIncidentReadinessDataset(filters, userId);
        return {
          common: {
            buildingId: filters.buildingId,
            // Exactly the scope the owning service used: with a buildingId present its
            // `resolveBuildingScope` returns `[buildingId]` and nothing else, and it short-circuits
            // to zero rows when the accessible scope is empty. These rows DO carry a buildingId
            // column, but the scope is still reported from the authorization rather than derived
            // from the returned rows, so Reporting never re-derives or widens an access decision.
            buildingScope: [filters.buildingId],
            // NO PERIOD IS APPLIED BY THIS SOURCE. The owning service resolves only a Building
            // scope and calls its repository with no start or end, and the generated SQL carries no
            // date predicate, so dateFrom and dateTo do NOT restrict these rows. They are echoed
            // here as the period the caller requested and the parser normalized — never as a bound
            // that was enforced, and never reinterpreted as a filter over `updatedAt`.
            dateFrom: filters.dateFrom ?? null,
            dateTo: filters.dateTo ?? null,
            asOf,
          },
          // ONE table `securityOperationalIncidentReadiness` at ONE row per governed
          // incident-readiness dataset row. The row identity is the record's own `bindingId`,
          // copied verbatim; the nullable related facts (`securityPostId`, `teamId`,
          // `primaryWorkforceId`) may legitimately repeat across records and are preserved as
          // several rows — never collapsed, deduplicated, or elected as the latest, current or
          // primary record. The responsible team and workforce are copied as RESPONSIBILITY, never
          // relabeled as an executor or completer. No KPI is calculated and no readiness
          // percentage is derived from the persisted status.
          projected: projectSecurityOperationalIncidentReadiness(rows),
          // Echo the required `source` plus only the filters the owning parser actually accepted.
          // For INCIDENT_READINESS the owning read applies buildingId (on the record's own
          // building), securityPostId, teamId (the RESPONSIBLE team), workforceId (the RESPONSIBLE
          // workforce), status (the readiness status) and category. Unlike the other three sources
          // it applies NEITHER patrolRouteId NOR any date bound; those parsed fields are ignored by
          // that read exactly as the existing dataset endpoint ignores them, and none is
          // reinterpreted here.
          appliedFilters: echoFilters(filters, { source }),
        };
      }

      // Filter parsing, Building-existence and access assertion, period normalization and the
      // row read ALL stay with the owning BE-12M module: this adapter adds presentation only.
      // The public parser is reused verbatim, so no second patrol filter contract, no patrol
      // SQL and no second patrol read model is created here, and `patrol_schedule_bindings` is
      // never queried from Reporting.
      const filters = parseReportQuery(passThrough);

      // buildingId is REQUIRED for this dataset. The owning parser intentionally leaves it
      // optional because the security SUMMARY endpoint may roll up across every accessible
      // Building; the dataset endpoints are documented as requiring it. Asserting it here keeps
      // that documented dataset contract and structurally prevents the roll-up path, so this
      // export can never widen to Buildings the caller did not ask for. Presence only — the
      // owning parser remains the authority on UUID format and normalization.
      if (!filters.buildingId) {
        throw AppError.validation('Request validation failed.', [
          {
            field: 'buildingId',
            message: `buildingId is required for source=${source}.`,
          },
        ]);
      }

      // The owning patrol read publishes rows, not an envelope, and does not publish an instant,
      // so `asOf` is captured immediately before the call following the CORRECTIVE_ACTION
      // convention. It is export envelope metadata ONLY: no row is classified against it and no
      // missed, overdue, dueBefore or graceMinutes value is derived from it anywhere in this
      // path.
      const asOf = new Date().toISOString();
      const rows = await securityReportService.getPatrolDataset(filters, userId);
      return {
        common: {
          buildingId: filters.buildingId,
          // Exactly the scope the owning service used: with a buildingId present its
          // `resolveBuildingScope` returns `[buildingId]` and nothing else. Patrol rows carry no
          // buildingId column, so the scope is taken from the authorized filter rather than
          // derived from the returned rows, and it is never widened to every accessible Building.
          buildingScope: [filters.buildingId],
          // The owning parser's own normalized period, echoed unchanged. Its semantics belong to
          // BE-12M (`reportRange` turns a date-only dateTo into an exclusive next-day bound over
          // `gt.occurrence_at`); Reporting creates no second interpretation of it.
          dateFrom: filters.dateFrom ?? null,
          dateTo: filters.dateTo ?? null,
          asOf,
        },
        // ONE table `securityOperationalPatrol` at ONE row per governed patrol dataset row. The
        // row identity is (taskId, patrolScheduleBindingId) and rows are never collapsed,
        // deduplicated or elected. Since CR-BE-RN16-PATROL-FIELD-01 PART 00 (migration 0354) a
        // schedule definition holds at most one ACTIVE binding, so a repeated taskId cannot
        // arise. No KPI is calculated and this list is not a missed/overdue contributor list.
        projected: projectSecurityOperationalPatrol(rows),
        // Echo the required `source` plus only the filters the owning parser actually accepted.
        // For PATROL the owning read applies buildingId, securityPostId, patrolRouteId, status,
        // dateFrom and dateTo; any other parsed field is ignored by that read exactly as the
        // existing dataset endpoint ignores it, and none is reinterpreted here.
        appliedFilters: echoFilters(filters, { source }),
      };
    },
  },

  // ------------------------------------------------------------------
  // R10 PART 19 — INCIDENT_REGISTER
  //
  // A pure adapter over the EXISTING BE-21A shared Incident foundation list read. BE-21A is the
  // ONE Incident foundation that already serves Operational Incident (BE-21B), Asset Failure /
  // Defect (BE-21C) and Finding Escalation (BE-21D) behind its own `incidentType` discriminator,
  // so this dataset adds no incident lifecycle, no incident repository, no incident status
  // authority, no KPI authority, no universal incident model and no duplicate Incident model. The
  // BE-21B composite operational-incident view, the incident-closure read and the security
  // finding/incident KPI authority are all left separate and unchanged.
  // ------------------------------------------------------------------
  INCIDENT_REGISTER: {
    dataset: 'INCIDENT_REGISTER',
    datasetLabel: 'Incident Register',
    sourceAuthority: 'BE-21A incidents (shared Incident foundation list read)',
    // The enforcement point is the EXISTING `incident.read`, source-verified as the permission
    // that already gates GET /incidents -> listIncidentsHandler in `incident.routes`. No new
    // permission is introduced, and no incident.manage, security.read, reporting.read or admin
    // fallback is substituted.
    requiredReadPermission: 'incident.read',
    async load(passThrough, userId) {
      // The owning domain's own filter parser and list read are reused verbatim, so the filter
      // contract, the accessible-Building scoping, the incident query, the status vocabulary and
      // the row ordering all stay authoritative in BE-21A. No new SQL, no incident repository and
      // no second incident read model is created here.
      const filters = parseIncidentFilters(passThrough);
      // The owning read publishes rows, not an envelope, and publishes no instant, so `asOf` is
      // captured immediately before the call — the convention CORRECTIVE_ACTION already uses. It
      // is export envelope metadata only: no row is classified against it, and no closure,
      // overdue, age or SLA value is derived from it or from any incident instant.
      const asOf = new Date().toISOString();
      const rows = await listIncidents(filters, userId);
      return {
        common: {
          // Null for a multi-Building rollup, matching CORRECTIVE_ACTION and the register
          // datasets. `buildingId` stays an OPTIONAL narrowing filter because that is exactly what
          // the owning read supports: requiring it would narrow the source contract, and Reporting
          // invents neither a stricter nor a wider scope. A supplied buildingId is the one the
          // owning service already access-asserted for this actor.
          buildingId: filters.buildingId ?? null,
          // The owning read publishes rows, not a scope list, so the scope is the distinct set of
          // Buildings actually represented in those authoritative rows — the same projection
          // CORRECTIVE_ACTION makes. Every such Building was already inside the actor's
          // accessible-Building scope, which the owning service enforced in its own SQL, so this
          // never widens isolation and never bypasses client or Building isolation. It is scope
          // metadata about Buildings, not a dedup of incident rows, which are returned untouched.
          buildingScope: [...new Set(rows.map((row) => row.buildingId))].sort(),
          // IncidentFilters has no report date window and the owning SQL carries no date
          // predicate, so the envelope period stays null rather than reinterpreting reportedAt,
          // closedAt or updatedAt as a bound.
          dateFrom: null,
          dateTo: null,
          asOf,
        },
        // ONE table `incidentRegister` at ONE row per authoritative public incident row. The row
        // identity is the foundation record's own `id`, copied verbatim; `incidentNumber` is an
        // ordinary fact and never part of a composite key. No latest, current or primary incident
        // is elected, no row is collapsed or deduplicated, and no post-query filter, sort, group or
        // enrichment is applied. All three incident kinds share this one register, and no KPI is
        // calculated: no incident count, open count, critical count, closure rate, average age or
        // SLA KPI.
        projected: projectIncidentRegister(rows),
        // Echo only the filters the owning parser actually accepted: buildingId, incidentType,
        // severity, priority and status. No criticalOnly, openOnly, unresolvedOnly, overdue,
        // ageDays, SLA, latestOnly or currentOnly filter exists, and no generic page, limit,
        // offset, sort or search parameter is accepted or echoed.
        appliedFilters: echoFilters(filters),
      };
    },
  },

  // ------------------------------------------------------------------
  // R11 PART 02 — RECEIVING_REGISTER
  //
  // A pure adapter over the PART 01 internal receiving-register read contract
  // (`src/modules/receiving-register`), itself a bounded read model over the authoritative
  // BE-17G `receivings` table. This dataset adds no receiving lifecycle, no receiving
  // repository, no receiving status authority, no KPI authority and no second receiving read
  // model, and no receivings table is queried from Reporting. The register is
  // request-anchored: the schema persists no receiving → purchase order or PO-line reference,
  // so none is exposed or inferred here — not from vendor, readiness, item, quantity, request,
  // timestamp and not from the current live PO.
  // ------------------------------------------------------------------
  RECEIVING_REGISTER: {
    dataset: 'RECEIVING_REGISTER',
    datasetLabel: 'Receiving Register',
    sourceAuthority: 'R11 receiving-register (internal read over BE-17G receivings)',
    // The enforcement point is the EXISTING `receiving.read`, source-verified as the permission
    // that already gates every GET route in `receiving.routes` (/receivings/:id,
    // /buildings/:buildingId/receivings, /purchase-requests/:purchaseRequestId/receivings,
    // /service-requests/:serviceRequestId/receivings, /vendors/:vendorId/receivings). No new
    // permission is introduced, and no receiving.manage, inventory_stock.read, reporting.read or
    // admin fallback is substituted.
    requiredReadPermission: 'receiving.read',
    async load(passThrough, userId) {
      // The owning read contract's own filter parser and register read are reused verbatim, so
      // the filter contract, the accessible-Building scoping, the explicit-Building access
      // assertion, the half-open `received_at` window, the native status/type vocabularies and
      // the row ordering all stay authoritative in the PART 01 module. No new SQL, no receiving
      // repository and no second receiving read model is created here.
      const filters = parseReceivingRegisterQuery(passThrough);
      const source = await getReceivingRegister(filters, userId);
      return {
        common: {
          // Null for the source's own multi-Building rollup; the explicit buildingId (when
          // supplied) is the one the owning service already existence-checked and
          // access-asserted for this actor. Scope resolution is never repeated or widened here.
          buildingId: source.buildingId,
          // The Buildings the owning service actually resolved for this actor — every row is
          // structurally restricted to that set in the source's own SQL.
          buildingScope: source.buildingScope,
          // The bounded `received_at` window echoed from the source envelope; `received_at` is
          // the only period authority and no createdAt/updatedAt substitute exists.
          dateFrom: source.dateFrom,
          dateTo: source.dateTo,
          asOf: source.asOf,
        },
        // ONE table `receivingRegister` at ONE row per persisted receivings record. The row
        // identity is `receivingId`, copied verbatim. No purchaseOrderId or PO-line linkage is
        // exposed or inferred, no quantity is summed or converted, no monetary field exists and
        // no KPI is calculated: `kpis` is empty.
        projected: projectReceivingRegister(source.rows),
        // Echo only the filters the owning parser actually accepted: buildingId, receivingType,
        // status, vendorId, purchaseRequestId, serviceRequestId, materialRequestId, dateFrom and
        // dateTo. No purchaseOrderId, purchaseOrderLineId, workOrderId, invoiceId,
        // latestOnly/currentOnly selector, pagination or free-text search parameter is accepted
        // or echoed.
        appliedFilters: echoFilters(filters),
      };
    },
  },

  // ------------------------------------------------------------------
  // R11 PART 03C — PURCHASE_ORDER_REGISTER (view = HEADER | LINE)
  //
  // ONE dataset with TWO source-owned grains selected by a REQUIRED `view` discriminator,
  // following the SECURITY_OPERATIONAL_DETAIL and PERMIT_TO_WORK precedents: never one dataset
  // enum per grain, never both tables in one response, and never a flattened HEADER×LINE
  // fan-out. HEADER is a pure adapter over the EXISTING purchase-orders public read (already
  // set-based and access-scoped since CR-BE-R2P-01); LINE is a pure adapter over the R11 PART
  // 03B purchase-order-line-register public read — the set-based cross-PO line authority built
  // precisely because the per-PO public line read would force a prohibited N+1. No
  // purchase-order SQL, no repository import, no second read model and no header duplication is
  // created here, and the two views are never merged into a procurement mega-read: RFQ
  // provenance, price deviation, purchase-order readiness, SPK/work-contract, receiving,
  // vendor-invoice and operational-commitment drill authorities all stay out.
  // ------------------------------------------------------------------
  PURCHASE_ORDER_REGISTER: {
    dataset: 'PURCHASE_ORDER_REGISTER',
    datasetLabel: 'Purchase Order Register',
    sourceAuthority:
      'R11 purchase-orders public header read (HEADER) + purchase-order-line-register (LINE)',
    // The enforcement point is the EXISTING `purchase_order.read`, source-verified as the
    // permission that already gates every GET route in `purchase-order.routes`
    // (/purchase-orders, /purchase-orders/:id, /purchase-orders/:id/lines,
    // /purchase-order-lines/:lineId). No new permission is introduced. `price_catalog.read` is
    // deliberately NOT added: the advisory price-deviation read model is NOT part of this
    // dataset, so no price-authority field reaches this export and no conjunctive gating is
    // required. No purchase_order.manage, reporting.read or admin fallback is substituted.
    requiredReadPermission: 'purchase_order.read',
    async load(passThrough, userId) {
      // `view` is REQUIRED and selects exactly one grain: HEADER (one row per `purchase_orders`
      // record) or LINE (one row per `purchase_order_lines` record). The reader above rejects
      // every missing, empty, repeated or unknown value with a validation error — there is no
      // default view and nothing is inferred from the filters present.
      const view = readPurchaseOrderRegisterView(passThrough.view);

      if (view === 'HEADER') {
        // LINE-only filters FAIL CLOSED under HEADER instead of being silently ignored: the
        // owning header parser drops unknown query keys, and a dropped filter the caller
        // believes was applied would misdescribe the result set. Presence of the key with any
        // value (even empty) triggers the rejection — no intent is guessed.
        const lineOnlyPresent = (['materialRequestId', 'itemId'] as const).filter(
          (key) => passThrough[key] !== undefined && passThrough[key] !== null,
        );
        if (lineOnlyPresent.length > 0) {
          throw AppError.validation('Request validation failed.', [
            {
              field: lineOnlyPresent[0],
              message: `${lineOnlyPresent.join(', ')} ${
                lineOnlyPresent.length > 1 ? 'are' : 'is'
              } only valid for view=LINE.`,
            },
          ]);
        }
        // Transport mapping ONLY, not semantic reinterpretation: this dataset's stable
        // Reporting query names dateFrom/dateTo are handed to the OWNING header parser under
        // its own native names poDateFrom/poDateTo, where they keep the authority's exact
        // INCLUSIVE calendar-date semantics over `po_date` (`>= poDateFrom::date`,
        // `<= poDateTo::date`). No second date parser, no re-validation and no normalization
        // is created here — UUID, status, date-format and ordering rules are all the owning
        // parser's own (its validation errors surface under its native field names). Only the
        // seven documented transport keys are forwarded, so raw poDateFrom/poDateTo or any
        // other unknown key in the query can never reach the source parser.
        const filters = parsePurchaseOrderFilters({
          buildingId: passThrough.buildingId,
          vendorId: passThrough.vendorId,
          purchaseRequestId: passThrough.purchaseRequestId,
          serviceRequestId: passThrough.serviceRequestId,
          status: passThrough.status,
          poDateFrom: passThrough.dateFrom,
          poDateTo: passThrough.dateTo,
        });
        // The owning read publishes rows, not an envelope, and publishes no instant, so `asOf`
        // is captured immediately before the call — the INCIDENT_REGISTER / CORRECTIVE_ACTION
        // envelope-only convention and the only Reporting clock in this path. No row is
        // classified against it, and no ageing, SLA or readiness value is derived from it.
        const asOf = new Date().toISOString();
        const rows = await listPurchaseOrders(filters, userId);
        return {
          common: {
            // Null for the source's own multi-Building rollup; a supplied buildingId is the one
            // the owning service already existence-checked and access-asserted for this actor.
            // Scope resolution is never repeated or widened here.
            buildingId: filters.buildingId ?? null,
            // The owning read publishes rows, not a scope list, so the scope is the distinct
            // set of Buildings actually represented in those authoritative rows — the same
            // projection INCIDENT_REGISTER and CORRECTIVE_ACTION make. Every such Building was
            // already inside the actor's accessible scope, which the owning service enforced in
            // its own SQL (`building_id = ANY`, fail-closed on an empty scope), so this never
            // widens isolation. Scope metadata about Buildings, not a dedup of PO rows, which
            // are returned untouched.
            buildingScope: [...new Set(rows.map((row) => row.buildingId))].sort(),
            // The owning parser's own accepted window values, echoed unchanged: INCLUSIVE
            // calendar dates over `po_date`, the HEADER business period authority — never
            // reinterpreted as created_at, issued_at, cancelled_at or requiredDate.
            dateFrom: filters.poDateFrom ?? null,
            dateTo: filters.poDateTo ?? null,
            asOf,
          },
          // ONE table `purchaseOrderHeader` at ONE row per `purchase_orders` record; the source
          // identity `id` is projected as the explicit `purchaseOrderId` and every other fact is
          // verbatim. NO header total exists: no totalAmount, no ordered/received/remaining
          // quantity, no line count, and no RFQ, deviation, SPK or invoice state is exposed or
          // fetched — `currency` is context only, and `poReadinessId` is the row's own persisted
          // precondition reference, never an enrichment hook.
          projected: projectPurchaseOrderHeader(rows),
          // Echo the required `view` plus only the filters the owning parser actually accepted,
          // under its own native names. No page, limit, offset, sort, search, latestOnly or
          // currentOnly parameter is accepted or echoed.
          appliedFilters: echoFilters(filters, { view }),
        };
      }

      // view === 'LINE' — the frozen two-member vocabulary is exhausted by the HEADER branch
      // above, so this is the only remaining case and no third view can ever route here.
      // HEADER-native period names FAIL CLOSED under LINE for the same truthfulness reason: the
      // LINE parser ignores unknown keys, and poDateFrom/poDateTo are not query names this
      // dataset's contract accepts from either view (both views use dateFrom/dateTo).
      const headerNativePresent = (['poDateFrom', 'poDateTo'] as const).filter(
        (key) => passThrough[key] !== undefined && passThrough[key] !== null,
      );
      if (headerNativePresent.length > 0) {
        throw AppError.validation('Request validation failed.', [
          {
            field: headerNativePresent[0],
            message: `${headerNativePresent.join(', ')} ${
              headerNativePresent.length > 1 ? 'are' : 'is'
            } not a PURCHASE_ORDER_REGISTER query name; use dateFrom/dateTo.`,
          },
        ]);
      }
      // The PART 03B register's own parser and read are reused verbatim: the nine-filter
      // contract (the seven common transport names plus LINE-only materialRequestId/itemId),
      // strict YYYY-MM-DD validation with the 366-day reporting-safety bound, the
      // accessible-Building scope resolution, the explicit-Building existence check and access
      // assertion, the INCLUSIVE `po_date` window, the native status vocabulary and the
      // deterministic row order all stay authoritative in the owning module. The `view` key
      // itself is unknown to that parser and ignored by it — the discriminator is owned here,
      // the filters are owned there.
      const filters = parsePurchaseOrderLineRegisterQuery(passThrough);
      const source = await getPurchaseOrderLineRegister(filters, userId);
      return {
        common: {
          // The owning envelope forwarded field-for-field: `buildingScope` is the scope the
          // service actually authorized (never derived from the returned rows, never widened),
          // and `asOf`, `dateFrom` and `dateTo` are the register's own single clock and
          // inclusive window. Nothing here reads a clock for this view.
          buildingId: source.buildingId,
          buildingScope: source.buildingScope,
          dateFrom: source.dateFrom,
          dateTo: source.dateTo,
          asOf: source.asOf,
        },
        // ONE table `purchaseOrderLine` at ONE row per `purchase_order_lines` record; identity
        // `purchaseOrderLineId`. `unitPrice`, `lineAmount` and the parent's `currency` are
        // persisted historical transactional facts copied verbatim: nothing is summed into a PO
        // total, recomputed from quantity × price, converted, tax-adjusted or compared against
        // any price catalog. `quantitySnapshot` stays the frozen commit-time snapshot under its
        // own name (never relabeled ordered/approved/received/remaining), and
        // `purchaseOrderStatus` is the parent PO's native status — a line owns no lifecycle of
        // its own, so no lineStatus exists. The line's own `serviceRequestId` /
        // `materialRequestId` lineage is preserved from the LINE authority and never
        // overwritten with parent-header semantics.
        projected: projectPurchaseOrderLine(source.rows),
        // Echo the required `view` plus only the filters the owning parser actually accepted.
        appliedFilters: echoFilters(filters, { view }),
      };
    },
  },

  // ------------------------------------------------------------------
  // R11 PART 04 — VENDOR_INVOICE_REGISTER
  //
  // A pure adapter over the EXISTING vendor-invoices public list read (CR-BE-COM-02): the
  // row-level commercial anchor for vendor invoicing, ONE row per persisted `vendor_invoices`
  // record. This dataset adds no invoice lifecycle, no verification, matching, settlement or
  // payment authority, no repository access and no second invoice read model, and no
  // vendor_invoices or vendor_invoice_history table is queried from Reporting. It is NOT a
  // payment-event ledger (no discrete vendor payment documents exist in the schema — a known
  // R11 non-blocking limitation), NOT an accounting or tax surface, and NOT a vendor
  // operational lifecycle report: R10 VENDOR_SERVICE_REGISTER remains authoritative for vendor
  // execution/lifecycle. The persisted lineage ids stay bare drill handles — vendor work, work
  // order, completion/service report, BAST, purchase order and SPK details are separate drill
  // authorities and are never fetched or joined here.
  // ------------------------------------------------------------------
  VENDOR_INVOICE_REGISTER: {
    dataset: 'VENDOR_INVOICE_REGISTER',
    datasetLabel: 'Vendor Invoice Register',
    sourceAuthority: 'CR-BE-COM-02 vendor-invoices (public list read)',
    // The enforcement point is the EXISTING `vendor_invoice.read`, source-verified as the
    // permission that already gates GET /vendor-invoices -> listVendorInvoicesHandler in
    // `vendor-invoice.routes`. No new permission is introduced, and no vendor_invoice.manage,
    // reporting.read or admin fallback is substituted.
    requiredReadPermission: 'vendor_invoice.read',
    async load(passThrough, userId) {
      // The source-native period names FAIL CLOSED instead of being silently dropped: this
      // dataset's transport contract is dateFrom/dateTo (mapped below), the owning parser
      // ignores unknown query keys, and a discarded filter the caller believes was applied
      // would misdescribe the result set — the same truthfulness rule PURCHASE_ORDER_REGISTER
      // enforces for poDateFrom/poDateTo.
      const nativeDateNamesPresent = (['invoiceDateFrom', 'invoiceDateTo'] as const).filter(
        (key) => passThrough[key] !== undefined && passThrough[key] !== null,
      );
      if (nativeDateNamesPresent.length > 0) {
        throw AppError.validation('Request validation failed.', [
          {
            field: nativeDateNamesPresent[0],
            message: `${nativeDateNamesPresent.join(', ')} ${
              nativeDateNamesPresent.length > 1 ? 'are' : 'is'
            } not a VENDOR_INVOICE_REGISTER query name; use dateFrom/dateTo.`,
          },
        ]);
      }
      // Transport mapping ONLY, not semantic reinterpretation: this dataset's stable Reporting
      // query names dateFrom/dateTo are handed to the OWNING parser under its own native names
      // invoiceDateFrom/invoiceDateTo, where they keep the authority's exact INCLUSIVE
      // calendar-date semantics over `invoice_date` (`>= invoiceDateFrom::date`,
      // `<= invoiceDateTo::date`). No second date parser, no re-validation and no
      // normalization is created here — UUID, status, strict YYYY-MM-DD date and window-order
      // rules are all the owning parser's own (its validation errors surface under its native
      // field names). Only the eight documented transport keys are forwarded, so any other
      // unknown key in the query can never reach the source parser.
      const filters = parseVendorInvoiceFilters({
        vendorId: passThrough.vendorId,
        buildingId: passThrough.buildingId,
        workOrderId: passThrough.workOrderId,
        purchaseOrderId: passThrough.purchaseOrderId,
        workContractId: passThrough.workContractId,
        status: passThrough.status,
        invoiceDateFrom: passThrough.dateFrom,
        invoiceDateTo: passThrough.dateTo,
      });
      // The owning read publishes rows, not an envelope, and publishes no instant, so `asOf`
      // is captured immediately before the call — the INCIDENT_REGISTER / PURCHASE_ORDER_REGISTER
      // envelope-only convention and the only Reporting clock in this path. No row is classified
      // against it, and no ageing or overdue value is derived from it or from any invoice
      // instant.
      const asOf = new Date().toISOString();
      const rows = await listVendorInvoices(filters, userId);
      return {
        common: {
          // Null for the source's own multi-Building rollup; a supplied buildingId is the one
          // the owning service already access-asserted for this actor. Scope resolution is
          // never repeated or widened here.
          buildingId: filters.buildingId ?? null,
          // The owning read publishes rows, not a scope list, so the scope is the distinct set
          // of Buildings actually represented in those authoritative rows — the same projection
          // INCIDENT_REGISTER, CORRECTIVE_ACTION and PURCHASE_ORDER_REGISTER make. Every such
          // Building was already inside the actor's accessible scope, which the owning service
          // enforced in its own SQL (`building_id = ANY`, fail-closed on an empty scope), so
          // this never widens isolation. Scope metadata about Buildings, not a dedup of invoice
          // rows, which are returned untouched.
          buildingScope: [...new Set(rows.map((row) => row.buildingId))].sort(),
          // The owning parser's own accepted window values, echoed unchanged: INCLUSIVE
          // calendar dates over `invoice_date`, the invoice business period authority — never
          // reinterpreted as createdAt, receivedDate, finalizedAt, verifiedAt or
          // lastPaymentDate.
          dateFrom: filters.invoiceDateFrom ?? null,
          dateTo: filters.invoiceDateTo ?? null,
          asOf,
        },
        // ONE table `vendorInvoiceRegister` at ONE row per `vendor_invoices` record; the source
        // identity `id` is projected as the explicit `vendorInvoiceId` and every other public
        // fact is verbatim. The three native status dimensions stay separate; money values are
        // copied with zero arithmetic; discrepancyCodes stays an on-row fact and is never fanned
        // out; no payment event, history row, KPI or total is materialized.
        projected: projectVendorInvoiceRegister(rows),
        // Echo only the filters the owning parser actually accepted, under its own native names.
        // No verificationStatus, paymentStatus, invoiceNumber, discrepancyCode, amountMin/Max,
        // search, latestOnly, currentOnly, page or limit filter exists in the source contract,
        // and none is invented here.
        appliedFilters: echoFilters(filters),
      };
    },
  },

  // ------------------------------------------------------------------
  // R11 PART 05C — STOCK_MOVEMENT_REGISTER
  //
  // A pure adapter over the R11 PART 05B stock-movement-register governed read: the append-only
  // inventory movement ledger (BE-16D) at native row grain, ONE row per persisted
  // `inventory_stock_movements` record, identity `stockMovementId`. This dataset adds no
  // movement lifecycle, no current-balance authority, no repository access and no second
  // movement read model, and no inventory_stock_movements or inventory_stock_balances table is
  // queried from Reporting. It is NOT a valuation or costing surface (ZERO monetary authority —
  // a known R11 non-blocking absence), NOT a receiving report (RECEIVING_REGISTER remains
  // authoritative there), NOT a work-order material-usage report, NOT a reservation, transfer or
  // adjustment report, and NOT an accounting ledger: the generic persisted `reference`/`source`
  // texts stay bare on-row facts and are never resolved into any domain, and no reverse join is
  // performed even where other domains persist a movement id. The resulting quantity snapshots
  // are HISTORICAL post-movement values, never current balances — the stock-balance domain
  // remains the sole current-balance authority.
  // ------------------------------------------------------------------
  STOCK_MOVEMENT_REGISTER: {
    dataset: 'STOCK_MOVEMENT_REGISTER',
    datasetLabel: 'Stock Movement Register',
    sourceAuthority:
      'R11 stock-movement-register (governed internal read over BE-16D inventory_stock_movements)',
    // The enforcement point is the EXISTING `inventory_stock.read`, source-verified as the
    // permission that already gates every stock-movement GET route in
    // `inventory-stock-movement.routes` (/warehouses/:warehouseId/stock-movements,
    // /buildings/:buildingId/stock-movements, /clients/:clientId/stock-movements and
    // /stock-movements/:id). No new permission is introduced, and no inventory_stock.manage,
    // reporting.read or admin fallback is substituted.
    requiredReadPermission: 'inventory_stock.read',
    async load(passThrough, userId) {
      // The owning read contract's own filter parser and register read are reused verbatim, so
      // the eight-filter contract, the strict real-YYYY-MM-DD validation, the half-open UTC
      // `movement_date` window normalization, the explicit-Building access assertion, the
      // accessible-Building rollup, the fail-closed empty scope, the native STOCK_IN/STOCK_OUT
      // vocabulary validation and the row ordering all stay authoritative in the PART 05B
      // foundation. No new SQL, no movement repository, no second date parser and no second
      // movement read model is created here. Exactly the eight documented transport keys are
      // forwarded — under names identical on both sides, so no mapping exists to misdescribe —
      // and no other query key can ever reach the source parser.
      const filters = parseStockMovementRegisterQuery({
        buildingId: passThrough.buildingId,
        warehouseId: passThrough.warehouseId,
        itemId: passThrough.itemId,
        movementType: passThrough.movementType,
        dateFrom: passThrough.dateFrom,
        dateTo: passThrough.dateTo,
        performedByUserId: passThrough.performedByUserId,
        reference: passThrough.reference,
      });
      const source = await getStockMovementRegister(filters, userId);
      return {
        common: {
          // Null for the source's own multi-Building rollup; the explicit buildingId (when
          // supplied) is the one the owning service already existence-checked and
          // access-asserted for this actor. Scope resolution is never repeated or widened here.
          buildingId: source.buildingId,
          // The Buildings the owning service actually resolved for this actor — every row is
          // structurally restricted to that set in the source's own SQL.
          buildingScope: source.buildingScope,
          // The accepted strict calendar dates echoed from the source envelope; the source owns
          // their normalization to the half-open UTC window over `movement_date`, the movement
          // business period authority. Never reinterpreted here and never a createdAt
          // substitute.
          dateFrom: source.dateFrom,
          dateTo: source.dateTo,
          asOf: source.asOf,
        },
        // ONE table `stockMovementRegister` at ONE row per persisted movement record; the
        // source identity `stockMovementId` and every other public fact are verbatim. The
        // native movement type is never accompanied by an invented lifecycle status, quantities
        // are never summed or converted, the resulting snapshots stay historical, no monetary
        // field exists and no KPI is calculated: `kpis` is empty.
        projected: projectStockMovementRegister(source.rows),
        // Echo only the filters the owning parser actually accepted: buildingId, warehouseId,
        // itemId, movementType, dateFrom, dateTo, performedByUserId and reference. No clientId,
        // search, receivingId, purchaseOrderId, purchaseOrderLineId, materialRequestId,
        // workOrderId, vendorId, reservationId, cost/value filter, latestOnly/currentOnly
        // selector or pagination parameter is accepted or echoed.
        appliedFilters: echoFilters(filters),
      };
    },
  },

  // ------------------------------------------------------------------
  // R11 PART 06 — OPERATIONAL_BUDGET_VARIANCE (view = BUDGET | CATEGORY)
  //
  // ONE dataset with TWO source-owned grains selected by a REQUIRED `view` discriminator,
  // following the PURCHASE_ORDER_REGISTER and SECURITY_OPERATIONAL_DETAIL precedents: never one
  // dataset enum per grain, never both tables in one response, and never a budget×category
  // flattening. Both views are pure adapters over the EXISTING operational-finance variance
  // read authority (CR-BE-COMM-VAR-01): BUDGET re-presents the governed list read's budget-level
  // variance summaries; CATEGORY re-presents the `categories` child grain of the single-budget
  // detail read, addressed by a REQUIRED budgetId. Reporting calculates NO financial semantics:
  // every amount, percentage, control and gap count is the source's own read-time computed
  // value copied verbatim. No operational-finance SQL, no repository import, no second variance
  // model and no traceability expansion is created here — purchase orders, PO lines, vendor
  // invoices, vendor service costs, WO material usages, basic expenses, source bindings,
  // commitment entries, RFQ and receivings all stay out, and the existing traceability endpoint
  // remains a separate drill authority.
  // ------------------------------------------------------------------
  OPERATIONAL_BUDGET_VARIANCE: {
    dataset: 'OPERATIONAL_BUDGET_VARIANCE',
    datasetLabel: 'Operational Budget Variance',
    sourceAuthority:
      'CR-BE-COMM-VAR-01 operational-finance variance read (BUDGET list + CATEGORY detail grains)',
    // The enforcement point is the EXISTING `operational_budget.read`, source-verified as the
    // permission that already gates every variance/traceability GET route in
    // `operational-finance.routes` (/operational-budget-variance,
    // /buildings/:buildingId/operational-budget-variance, /operational-budgets/:budgetId/variance
    // and /operational-budgets/:budgetId/traceability). No new permission is introduced, and no
    // operational_budget.manage, reporting.read or admin fallback is substituted.
    requiredReadPermission: 'operational_budget.read',
    async load(passThrough, userId) {
      // `view` is REQUIRED and selects exactly one grain: BUDGET (one row per budget-level
      // variance summary) or CATEGORY (one row per persisted budget category). The reader above
      // rejects every missing, empty, repeated or unknown value with a validation error — there
      // is no default view and nothing is inferred from the filters present.
      const view = readOperationalBudgetVarianceView(passThrough.view);

      if (view === 'BUDGET') {
        // The CATEGORY-only budgetId FAILS CLOSED under BUDGET instead of being silently
        // ignored: the owning parser drops unknown query keys, and a dropped filter the caller
        // believes was applied would misdescribe the result set. Presence of the key with any
        // value (even empty) triggers the rejection — no intent is guessed.
        const categoryOnlyPresent = (['budgetId'] as const).filter(
          (key) => passThrough[key] !== undefined && passThrough[key] !== null,
        );
        if (categoryOnlyPresent.length > 0) {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'budgetId',
              message: 'budgetId is only valid for view=CATEGORY.',
            },
          ]);
        }
        // The owning parser is reused verbatim: UUID validation, the native budget status
        // vocabulary and the strict real-YYYY-MM-DD periodFrom/periodTo budget-period OVERLAP
        // window (period_end >= periodFrom, period_start <= periodTo) all stay authoritative in
        // operational-finance. No second period parser exists here, the transport names are the
        // source's own (no mapping), and only the four documented keys are forwarded, so no
        // other query key can ever reach the source parser.
        const filters = parseOperationalBudgetFilters({
          buildingId: passThrough.buildingId,
          status: passThrough.status,
          periodFrom: passThrough.periodFrom,
          periodTo: passThrough.periodTo,
        });
        // The owning list read publishes summary rows, not an envelope, and publishes no
        // instant, so `asOf` is captured immediately before the call — the INCIDENT_REGISTER /
        // PURCHASE_ORDER_REGISTER envelope-only convention and the only Reporting clock in this
        // path. No row is classified against it and no ageing value is derived from it.
        const asOf = new Date().toISOString();
        const rows = await operationalVarianceService.listOperationalBudgetVariance(
          filters,
          userId,
        );
        return {
          common: {
            // Null for the source's own multi-Building rollup; a supplied buildingId is the one
            // the owning service already access-asserted for this actor. Scope resolution is
            // never repeated or widened here.
            buildingId: filters.buildingId ?? null,
            // The owning read publishes rows, not a scope list, so the scope is the distinct
            // set of Buildings actually represented in those authoritative rows — the same
            // projection INCIDENT_REGISTER, PURCHASE_ORDER_REGISTER and VENDOR_INVOICE_REGISTER
            // make. Every such Building was already inside the actor's accessible scope, which
            // the owning service enforced in its own SQL (`building_id = ANY`, fail-closed on an
            // empty scope), so this never widens isolation. Scope metadata about Buildings, not
            // a dedup of budget rows, which are returned untouched.
            buildingScope: [...new Set(rows.map((row) => row.buildingId))].sort(),
            // The owning parser's own accepted period-window values, echoed unchanged: the
            // budget control-period OVERLAP filter (periodFrom/periodTo over the budgets' own
            // period_start/period_end) — never reinterpreted as createdAt, updatedAt,
            // commitment or invoice timestamps.
            dateFrom: filters.periodFrom ?? null,
            dateTo: filters.periodTo ?? null,
            asOf,
          },
          // ONE table `operationalBudgetVariance` at ONE row per budget-level variance summary;
          // identity `budgetId`. Every figure is the source's own computed value copied
          // verbatim — no cross-currency sum, no FX, no consolidated KPI, and the categories
          // child grain is never embedded here.
          projected: projectOperationalBudgetVariance(rows),
          // Echo the required `view` plus only the filters the owning parser actually accepted,
          // under its own native names. No currency, vendorId, purchaseOrderId, invoiceId,
          // workOrderId, categoryId, search, page, limit, latestOnly or currentOnly parameter
          // is accepted or echoed.
          appliedFilters: echoFilters(filters, { view }),
        };
      }

      // view === 'CATEGORY' — the frozen two-member vocabulary is exhausted by the BUDGET
      // branch above, so this is the only remaining case and no third view can ever route here.
      // The BUDGET-only list filters FAIL CLOSED under CATEGORY for the same truthfulness
      // reason: the detail read is addressed by budgetId alone and would ignore them, and a
      // dropped filter the caller believes was applied would misdescribe the result set.
      const budgetOnlyPresent = (
        ['buildingId', 'status', 'periodFrom', 'periodTo'] as const
      ).filter((key) => passThrough[key] !== undefined && passThrough[key] !== null);
      if (budgetOnlyPresent.length > 0) {
        throw AppError.validation('Request validation failed.', [
          {
            field: budgetOnlyPresent[0],
            message: `${budgetOnlyPresent.join(', ')} ${
              budgetOnlyPresent.length > 1 ? 'are' : 'is'
            } only valid for view=BUDGET.`,
          },
        ]);
      }
      // budgetId is REQUIRED under CATEGORY — that is how the source authority addresses the
      // categories child grain (GET /operational-budgets/:budgetId/variance). A missing, empty
      // or non-string value is rejected rather than widened into a cross-budget category
      // search, which the source does not own and this dataset must not invent. The owning
      // param parser then validates and normalizes the UUID exactly as the source route does.
      const rawBudgetId =
        typeof passThrough.budgetId === 'string' && passThrough.budgetId.trim() !== ''
          ? passThrough.budgetId
          : undefined;
      if (rawBudgetId === undefined) {
        throw AppError.validation('Request validation failed.', [
          {
            field: 'budgetId',
            message: 'budgetId is required for view=CATEGORY.',
          },
        ]);
      }
      const budgetId = parseOperationalBudgetIdParam(rawBudgetId);
      // The owning detail read existence-checks the budget and asserts the actor's Building
      // access before computing anything; its envelope (single budget, single currency, its own
      // asOf clock) is forwarded field-for-field — scope is never re-resolved or widened here.
      const source = await operationalVarianceService.getOperationalBudgetVariance(
        budgetId,
        userId,
      );
      return {
        common: {
          // The single budget's Building — the one the owning service just access-asserted.
          buildingId: source.buildingId,
          buildingScope: [source.buildingId],
          // The detail read is addressed by budgetId and takes no period filter; the budget's
          // own control period is a row fact, never an envelope window.
          dateFrom: null,
          dateTo: null,
          // The source envelope's own single clock — no Reporting clock is read for this view.
          asOf: source.asOf,
        },
        // ONE table `operationalBudgetVarianceCategory` at ONE row per persisted budget
        // category of the addressed budget; identity `budgetId` + `budgetCategoryId`. Parent
        // context (client, building, currency, control period, native status and overspend
        // policy) is copied from the envelope; the budget's own totals are NEVER duplicated
        // onto category rows and every per-category figure is the source's own computed value.
        projected: projectOperationalBudgetVarianceCategory(source),
        // Echo the required `view` plus the addressed budgetId — the only filter this view
        // accepts.
        appliedFilters: echoFilters({ budgetId }, { view }),
      };
    },
  },
  ESG_METRIC_TREND: {
    dataset: 'ESG_METRIC_TREND',
    datasetLabel: 'ESG Metric Trend',
    sourceAuthority: 'CR-BE-ESG-01 esg-metric-values readEsgMetricValues',
    requiredReadPermission: 'esg.read',
    async load(passThrough, userId) {
      const request = readEsgMetricTrendRequest(passThrough);
      const source = await esgMetricValueService.readEsgMetricValues(request, userId);
      const buildingScope = [...new Set(source.map((row) => row.buildingId))];

      return {
        common: {
          buildingId: buildingScope.length === 1 ? buildingScope[0]! : null,
          buildingScope,
          dateFrom: request.periodStart,
          dateTo: request.periodEnd,
          asOf: new Date().toISOString(),
        },
        projected: projectEsgMetricTrend(source),
        appliedFilters: echoFilters(
          {
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
          },
          {
            buildingIds: request.buildingIds.join(','),
            metricDefinitionIds: request.metricDefinitionIds?.join(',') ?? null,
          },
        ),
      };
    },
  },
  ESG_WASTE_REGISTER: {
    dataset: 'ESG_WASTE_REGISTER',
    datasetLabel: 'ESG Waste Register',
    sourceAuthority: 'CR-BE-ESG-01 esg-waste-records readEsgWasteRecords',
    requiredReadPermission: 'esg.read',
    async load(passThrough, userId) {
      const request = readEsgWasteRegisterRequest(passThrough);
      const source = await esgWasteRecordService.readEsgWasteRecords(request, userId);
      const buildingScope = [...new Set(source.map((row) => row.buildingId))];

      return {
        common: {
          buildingId: buildingScope.length === 1 ? buildingScope[0]! : null,
          buildingScope,
          dateFrom: request.periodStart,
          dateTo: request.periodEnd,
          asOf: new Date().toISOString(),
        },
        projected: projectEsgWasteRegister(source),
        appliedFilters: echoFilters(
          {
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
          },
          { buildingIds: request.buildingIds.join(',') },
        ),
      };
    },
  },
  UTILITY_CONSUMPTION_TREND: {
    dataset: 'UTILITY_CONSUMPTION_TREND',
    datasetLabel: 'Utility Consumption Trend',
    sourceAuthority: 'BE-18G utility-meter-consumptions readUtilityConsumptionTrend',
    requiredReadPermission: 'utility_kpi.read',
    async load(passThrough, userId) {
      const request = readUtilityConsumptionTrendRequest(passThrough);
      const source = await utilityMeterConsumptionService.readUtilityConsumptionTrend(
        request,
        userId,
      );
      const buildingScope = [...new Set(source.map((row) => row.buildingId))];

      return {
        common: {
          buildingId: buildingScope.length === 1 ? buildingScope[0]! : null,
          buildingScope,
          dateFrom: request.periodStart.toISOString(),
          dateTo: request.periodEnd.toISOString(),
          asOf: new Date().toISOString(),
        },
        projected: projectUtilityConsumptionTrend(source),
        appliedFilters: echoFilters(
          {
            periodStart: request.periodStart.toISOString(),
            periodEnd: request.periodEnd.toISOString(),
            interval: request.interval,
          },
          {
            buildingIds: request.buildingIds.join(','),
            utilityTypes: request.utilityTypes?.join(',') ?? null,
          },
        ),
      };
    },
  },
  PORTFOLIO_OPERATIONAL_COMPARISON: {
    dataset: 'PORTFOLIO_OPERATIONAL_COMPARISON',
    datasetLabel: 'Portfolio Operational Comparison',
    sourceAuthority:
      'Existing governed Work Order, Finding, Incident, Checklist/Form Execution and Scheduled Operation reads',
    requiredReadPermission: 'work_order.read',
    async load(passThrough, userId) {
      const request = readPortfolioOperationalComparisonRequest(passThrough);
      const sourceFilters = {
        dateFrom: request.periodStart,
        dateTo: request.periodEnd,
      };
      const [workOrders, findings, incidents, executions, scheduledOperations] =
        await Promise.all([
          workOrderRegisterService.getWorkOrderRegister(
            parseWorkOrderRegisterQuery(sourceFilters),
            userId,
          ),
          findingRegisterService.getFindingRegister(
            parseFindingRegisterQuery(sourceFilters),
            userId,
          ),
          incidentService.listIncidents(parseIncidentFilters({}), userId),
          checklistExecutionSummaryService.getChecklistExecutionSummary(
            parseChecklistExecutionSummaryQuery(sourceFilters),
            userId,
          ),
          scheduledOperationLineageService.getScheduledOperationLineage(
            parseScheduledOperationLineageQuery(sourceFilters),
            userId,
          ),
        ]);

      const requestedBuildingIds = new Set(request.buildingIds);
      const counts = new Map<
        string,
        Map<PortfolioOperationalComparisonMetric, number>
      >();
      addPortfolioComparisonRows(
        counts,
        requestedBuildingIds,
        'WORK_ORDER_ORIGINATED',
        workOrders.rows,
      );
      addPortfolioComparisonRows(
        counts,
        requestedBuildingIds,
        'FINDING_REPORTED',
        findings.rows,
      );
      const { start, end } = portfolioComparisonDateRange(request);
      addPortfolioComparisonRows(
        counts,
        requestedBuildingIds,
        'INCIDENT_REPORTED',
        incidents.filter(
          (row) =>
            new Date(row.reportedAt) >= start && new Date(row.reportedAt) < end,
        ),
      );
      addPortfolioComparisonRows(
        counts,
        requestedBuildingIds,
        'CHECKLIST_EXECUTION_ORIGINATED',
        executions.rows,
      );
      addPortfolioComparisonRows(
        counts,
        requestedBuildingIds,
        'SCHEDULED_OPERATION_PLANNED',
        scheduledOperations.rows,
      );

      const rows = buildPortfolioOperationalComparisonRows(request, counts);
      return {
        common: {
          buildingId: null,
          buildingScope: [...new Set(rows.map((row) => row.buildingId))],
          dateFrom: request.periodStart,
          dateTo: request.periodEnd,
          asOf: new Date().toISOString(),
        },
        projected: projectPortfolioOperationalComparison(rows),
        appliedFilters: echoFilters(
          { periodStart: request.periodStart, periodEnd: request.periodEnd },
          { buildingIds: request.buildingIds.join(',') },
        ),
      };
    },
  },

};

export function getReportingExportDatasetAdapter(
  dataset: unknown,
): ReportingExportDatasetAdapter {
  if (!isReportingExportDataset(dataset)) {
    throw AppError.badRequest(
      `dataset must be one of: ${REPORTING_EXPORT_DATASETS.join(', ')}.`,
    );
  }
  return REPORTING_EXPORT_DATASET_REGISTRY[dataset];
}
