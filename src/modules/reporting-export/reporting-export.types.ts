/**
 * BE-23J — Export Dataset domain types.
 *
 * A neutral, export-ready envelope over the BE-23 reporting read models.
 * It is the LAST step of the BE-23 reporting wave and deliberately the
 * thinnest: it re-presents figures the BE-23F1 / F2 / G / H / I services
 * already produced, in a row/column shape a consumer can hand to a
 * spreadsheet writer, a CSV serialiser or a table component.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 *   - It does NOT recalculate any KPI. Every value is read verbatim from
 *     the owning BE-23 service; there is no arithmetic here beyond
 *     copying and labelling. If a number is wrong, it is wrong in the
 *     owning KPI module, and it is fixed there.
 *   - It does NOT render charts. No series colours, axes, or plotting
 *     hints — `rows`/`columns` are data, not presentation.
 *   - It does NOT generate PDF or Excel files. No binary encoding, no
 *     file writing, no attachment headers. The response is JSON; the
 *     PART 02 CSV renderer is a separate pure serializer over this shape,
 *     and persistence/rendering of other documents belongs to later PARTs.
 *   - It is NOT a BI / warehouse layer. Nothing is materialised, no fact
 *     or dimension tables exist, no ETL runs. Every request reads live
 *     through the KPI services, so an export can never drift from the
 *     operational records behind it.
 *
 * The value it adds is uniformity: five KPI modules with five different
 * response shapes become one predictable envelope carrying period /
 * filter metadata, flat KPI values, structured rows and columns, and the
 * instant the export was generated.
 */

/** BE-23 KPI and approved BE-24 management read models this can project. */
export const REPORTING_EXPORT_DATASETS = [
  'SECURITY_PATROL',
  'SECURITY_FINDING_INCIDENT',
  'WORKFORCE',
  'VENDOR_TENANT',
  'UTILITY',
  'MANAGEMENT_OPERATIONS_COMMAND_CENTER',
  'VENDOR_SERVICE_REGISTER',
  'FINDING_REGISTER',
  'WORK_ORDER_REGISTER',
  'CHECKLIST_EXECUTION_SUMMARY',
  'OPERATIONAL_DETAIL',
  // R10 PART 02 — pure Reporting adapter over the existing authoritative
  // corrective-action read. Adds no HSE business authority and no second
  // corrective-action read model.
  'CORRECTIVE_ACTION',
  // R10 PART 03 — adapter over the EXISTING R08 child-history grains. Each R08
  // child stays a separate grain behind the required `history` discriminator;
  // no child is flattened into one fan-out rowset and no new evidence SQL is
  // created here.
  'OPERATIONAL_DETAIL_HISTORY',
  // R10 PART 08 — adapter over the completed work-order-sla-register read model.
  // Grain stays ONE ROW PER SLA CLOCK, so a Work Order legitimately appears twice
  // (RESPONSE and RESOLUTION); the two clocks are never collapsed. Adds no SLA
  // authority, no second SLA read model and no SLA KPI. OPERATIONAL_DETAIL_HISTORY
  // remains a SINGLE dataset despite its three `history` discriminators.
  'WORK_ORDER_SLA',
  // R10 PART 11 — adapter over the completed scheduled-operation-lineage read model.
  // Grain stays ONE ROW PER generated_tasks.id, so a schedule legitimately contributes
  // many rows (one per generated occurrence) and is never collapsed to one row per
  // schedule, per execution, per status or per assignment. `generatedTaskId` IS the task
  // identity: the schema has no `tasks` table and no `generated_tasks.task_id`, so no
  // `taskId` alias exists. Adds no scheduler, no recurrence expansion and no task KPI.
  'SCHEDULED_OPERATION_LINEAGE',
  // R10 PART 14 — adapter over the completed permit-to-work-register read model. ONE dataset with
  // TWO required presentation views, NOT two datasets: the caller must send `view=LIFECYCLE` or
  // `view=APPROVAL`, and that discriminator alone decides which single table the response carries.
  // LIFECYCLE is one row per `permit_applications.id`; APPROVAL is one row per
  // `permit_approval_bindings.id`, a true 1:N child, so one permit legitimately contributes many
  // approval rows and they are never collapsed. The two grains are never merged into a universal
  // permit row and never returned together. No current/latest/next approval and no stage
  // precedence exist, so none is presented. Adds no PTW SQL and no approval KPI.
  'PERMIT_TO_WORK',
  // R10 PART 15 — one dataset for the Security operational detail grains, behind a REQUIRED
  // `source` discriminator. PART 15 implements source=PATROL only; SHIFT_HANDOVER,
  // SECURITY_FINDING and INCIDENT_READINESS are declared here so the vocabulary is frozen and
  // complete, and the registry fails closed on any value its own PART has not implemented.
  // Declaring a value is NOT availability. There is deliberately no source-specific dataset
  // enum entry (no SECURITY_PATROL detail dataset, no PATROL_DETAIL, no
  // PATROL_OPERATIONAL_DETAIL) and no alias: the grain is selected by `source`, exactly as
  // OPERATIONAL_DETAIL_HISTORY selects its grain by `history`.
  'SECURITY_OPERATIONAL_DETAIL',
  // R10 PART 19 — pure Reporting adapter over the EXISTING BE-21A shared Incident foundation list
  // read (`listIncidents`). ONE Incident foundation already serves Operational Incident (BE-21B),
  // Asset Failure / Defect (BE-21C) and Finding Escalation (BE-21D) behind the source's own
  // `incidentType` discriminator, so this dataset adds no incident lifecycle, no incident
  // repository, no incident status authority, no KPI authority, no universal incident model and no
  // duplicate Incident model. The grain stays ONE ROW PER foundation record; the BE-21B composite
  // operational-incident view, the incident-closure read and the security finding/incident KPI
  // authority are all separate and unchanged.
  'INCIDENT_REGISTER',
  // R11 PART 02 — pure Reporting adapter over the PART 01 internal receiving-register read
  // contract (`src/modules/receiving-register`), itself a bounded read model over the
  // authoritative BE-17G `receivings` table. The grain stays ONE ROW PER persisted receivings
  // record and the identity is `receivingId`. The register is request-anchored: the schema
  // persists no receiving → purchase order or PO-line reference, so none is exposed or inferred
  // (not from vendor, readiness, item, quantity, request, timestamp or the current live PO). The
  // dataset carries NO monetary field and NO KPI: receiving is a quantity / operational receipt
  // fact. Exactly one table (`receivingRegister`) is emitted and the receivings domain keeps its
  // own status/type vocabularies, its `received_at` period authority and its accessible-Building
  // scoping — Reporting re-presents all of them verbatim.
  'RECEIVING_REGISTER',
  // R11 PART 03C — ONE dataset with TWO source-owned grains behind a REQUIRED `view`
  // discriminator (HEADER | LINE), following the SECURITY_OPERATIONAL_DETAIL / PERMIT_TO_WORK
  // precedent: never one dataset enum per grain. HEADER is a pure adapter over the EXISTING
  // purchase-orders public read (one row per `purchase_orders` record, identity `id` projected
  // as the explicit `purchaseOrderId`); LINE is a pure adapter over the R11 PART 03B
  // purchase-order-line-register (one row per `purchase_order_lines` record, identity
  // `purchaseOrderLineId`). Each response holds exactly ONE selected table —
  // `purchaseOrderHeader` or `purchaseOrderLine`, never both and never a flattened HEADER×LINE
  // fan-out. Both views share ONE date-filter meaning: INCLUSIVE calendar dates over the PO's
  // own `po_date` (stable transport names dateFrom/dateTo, mapped to the header authority's
  // native poDateFrom/poDateTo for HEADER only — a transport mapping, not a semantic
  // reinterpretation). The dataset carries NO header total and NO KPI: the LINE money facts
  // (unitPrice, lineAmount) and the parent currency are persisted historical values, never
  // summed, recomputed, converted or catalog-compared. No CSV default is configured — with two
  // possible tables the generic export requires the actually selected response table, so
  // OPERATIONAL_DETAIL remains the only dataset with a metadata default.
  'PURCHASE_ORDER_REGISTER',
  // R11 PART 04 — pure Reporting adapter over the EXISTING vendor-invoices public list read
  // (`listVendorInvoices`, CR-BE-COM-02): the row-level commercial anchor for vendor invoicing,
  // ONE row per persisted `vendor_invoices` record, identity `id` projected as the explicit
  // `vendorInvoiceId`. NOT a payment-event ledger, NOT an accounting/tax surface, NOT a vendor
  // operational lifecycle report (R10 VENDOR_SERVICE_REGISTER remains authoritative there) and
  // NOT a procurement mega-read: the persisted lineage ids (vendorWorkId, workOrderId,
  // completionReportId, serviceReportId, bastDocumentId, purchaseOrderId, workContractId) are
  // projected as bare drill handles and never fetched or enriched. The three native status
  // dimensions (status, verificationStatus, paymentStatus) stay separate and verbatim — never
  // collapsed, normalized or extended. Payment facts are CURRENT STATE ONLY (paidAmount,
  // outstandingAmount, lastPaymentDate, paymentStatus persisted on the invoice): no payment
  // event, instrument or history row exists in this dataset and `vendor_invoice_history` is
  // never expanded. All money values are copied verbatim with ZERO arithmetic — no outstanding
  // recomputation, no totals, no cross-currency aggregation, no FX, no tax. Period authority is
  // `invoice_date` under the source's own INCLUSIVE calendar-date window (transport dateFrom/
  // dateTo mapped to the parser's native invoiceDateFrom/invoiceDateTo). Exactly one table
  // (`vendorInvoiceRegister`), kpis empty, and no CSV default — OPERATIONAL_DETAIL remains the
  // only dataset with one.
  'VENDOR_INVOICE_REGISTER',
  // R11 PART 05C — pure Reporting adapter over the R11 PART 05B stock-movement-register
  // governed read: the append-only inventory movement ledger (BE-16D) at native row grain, ONE
  // row per persisted `inventory_stock_movements` record, identity `stockMovementId` (the only
  // rename). The movement vocabulary stays the source's native STOCK_IN | STOCK_OUT
  // direction/type discriminator — never a lifecycle status, and no generic status,
  // directionLabel or receipt/issue typing is invented. Quantities are per-row facts: never
  // summed across items or UOMs, never converted, never netted. `resultingQuantityOnHand` /
  // `resultingAvailableQuantity` are HISTORICAL post-movement snapshots, never current
  // balances — the stock-balance domain remains the sole current-balance authority and no
  // reserved quantity is derived. ZERO monetary authority: no cost, value, currency, COGS or
  // valuation exists or is inferred (a known R11 non-blocking absence). Period authority is
  // `movement_date` under the source's own strict-calendar-date half-open UTC window. The
  // generic persisted `reference`/`source` texts stay bare on-row facts and are never resolved
  // into any domain. Exactly one table (`stockMovementRegister`), kpis empty, and no CSV
  // default — OPERATIONAL_DETAIL remains the only dataset with one.
  'STOCK_MOVEMENT_REGISTER',
  // R11 PART 06 — pure Reporting adapter over the EXISTING operational-finance variance read
  // authority (CR-BE-COMM-VAR-01, `operationalVarianceService`): ONE dataset with TWO
  // source-owned grains behind a REQUIRED `view` discriminator (BUDGET | CATEGORY), following
  // the PURCHASE_ORDER_REGISTER and SECURITY_OPERATIONAL_DETAIL precedents. BUDGET is one row
  // per budget-level variance summary (the governed list read); CATEGORY is one row per
  // persisted budget category (the categories child grain of the single-budget detail read,
  // addressed by a REQUIRED budgetId). Never both tables in one response, never a
  // budget×category flattening and no category array embedded in a budget row. Reporting
  // calculates NO financial semantics: every amount, percentage, fail-closed control and gap
  // count is the source-computed value copied verbatim — no planned-minus-actual, available,
  // variance, utilization, open-commitment, actualization or release figure is computed or
  // re-derived here. Each row stays tied to exactly ONE budget currency: no cross-currency
  // total, no FX, no reporting-currency selection, no consolidated amount KPI. Period
  // authority is the budget's own control period (periodStart/periodEnd) under the
  // source-owned periodFrom/periodTo overlap filters — never a transaction timestamp. Native
  // budget status and overspend-policy vocabularies stay the source's own. Exactly one table
  // per view (`operationalBudgetVariance` | `operationalBudgetVarianceCategory`), kpis empty,
  // and no CSV default — with two possible tables the generic export requires the actually
  // selected response table, so OPERATIONAL_DETAIL remains the only dataset with a metadata
  // default.
  'OPERATIONAL_BUDGET_VARIANCE',
  // R12 PART 02 — pure adapter over the governed ESG metric-value source read. The grain stays
  // ONE ROW PER persisted ESG metric-value fact; Reporting exposes no trend calculation, carbon
  // conversion, target variance, interpolation, synthetic period or Utility-to-ESG inference.
  // Period containment, actor Building intersection, metric filtering and all native ESG values
  // remain owned by `readEsgMetricValues`.
  'ESG_METRIC_TREND',
  // R12 PART 03 — pure adapter over the bounded actor-scoped ESG waste read. The grain stays
  // ONE ROW PER persisted waste fact; quantity, UOM, period date and native status remain source
  // facts with no carbon, conversion, aggregation or Utility-to-ESG inference.
  'ESG_WASTE_REGISTER',
  // R12 PART 04 — bounded utility consumption buckets from persisted
  // utility_meter_consumptions facts. The source owns period_end bucketing,
  // Building access, utility type and UOM grouping; Reporting performs no
  // reading delta, conversion, cost, carbon, hierarchy or missing-period logic.
  'UTILITY_CONSUMPTION_TREND',
  // R12 PART 05 — absolute source-row counts only. No normalization, lifecycle reconstruction,
  // financial/sustainability comparison, score, rank or denominator is introduced.
  'PORTFOLIO_OPERATIONAL_COMPARISON',
] as const;

export const PORTFOLIO_OPERATIONAL_COMPARISON_METRICS = [
  'WORK_ORDER_ORIGINATED',
  'FINDING_REPORTED',
  'INCIDENT_REPORTED',
  'CHECKLIST_EXECUTION_ORIGINATED',
  'SCHEDULED_OPERATION_PLANNED',
] as const;
export type PortfolioOperationalComparisonMetric =
  (typeof PORTFOLIO_OPERATIONAL_COMPARISON_METRICS)[number];

export type PublicPortfolioOperationalComparisonRow = {
  buildingId: string;
  metric: PortfolioOperationalComparisonMetric;
  value: number;
  periodStart: string;
  periodEnd: string;
};

export const MANAGEMENT_REPORTING_EXPORT_DATASETS = [
  'MANAGEMENT_OPERATIONS_COMMAND_CENTER',
] as const;

export type ManagementReportingExportDataset =
  (typeof MANAGEMENT_REPORTING_EXPORT_DATASETS)[number];

export function isManagementReportingExportDataset(
  value: unknown,
): value is ManagementReportingExportDataset {
  return (
    typeof value === 'string' &&
    (MANAGEMENT_REPORTING_EXPORT_DATASETS as readonly string[]).includes(value)
  );
}

export type ReportingExportDataset =
  (typeof REPORTING_EXPORT_DATASETS)[number];

export function isReportingExportDataset(
  value: unknown,
): value is ReportingExportDataset {
  return (
    typeof value === 'string' &&
    (REPORTING_EXPORT_DATASETS as readonly string[]).includes(value)
  );
}

/**
 * R10 — the frozen `history` discriminator vocabulary for the
 * OPERATIONAL_DETAIL_HISTORY dataset.
 *
 * Declared ONCE here so the three R08 child grains cannot drift apart across
 * PARTs. Each value selects exactly one existing R08 child read at its OWN
 * grain, and exactly one table is emitted per response — the children are never
 * flattened into a single fan-out rowset.
 *
 * Declaring a value here does NOT make it available. The registry adapter is
 * the authority on which grains are actually implemented and rejects any value
 * whose PART has not landed with an explicit validation error, so no declared
 * value can ever route to a missing implementation. PART 03 implements
 * EVIDENCE only; FINDING_REWORK and REVIEW arrive in their own PARTs.
 */
export const OPERATIONAL_DETAIL_HISTORY_VALUES = [
  'EVIDENCE',
  'FINDING_REWORK',
  'REVIEW',
] as const;

export type OperationalDetailHistoryValue =
  (typeof OPERATIONAL_DETAIL_HISTORY_VALUES)[number];

export function isOperationalDetailHistoryValue(
  value: unknown,
): value is OperationalDetailHistoryValue {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_DETAIL_HISTORY_VALUES as readonly string[]).includes(value)
  );
}

/**
 * R10 PART 15 — the frozen `source` vocabulary for SECURITY_OPERATIONAL_DETAIL.
 *
 * Declared once, here, as the Reporting type authority, and complete: PATROL,
 * SHIFT_HANDOVER, SECURITY_FINDING and INCIDENT_READINESS. PART 15 implements PATROL only.
 * The registry holds the implemented subset and rejects any declared-but-unimplemented value
 * with an explicit validation error, following the OPERATIONAL_DETAIL_HISTORY staging pattern,
 * so no value can route to a missing implementation and none can silently return an empty
 * result set.
 *
 * `source` is REQUIRED. It has no default, is never inferred from the filters present, and an
 * omitted, empty, repeated or unknown value is a validation error rather than a fallback to
 * PATROL.
 */
export const SECURITY_OPERATIONAL_DETAIL_SOURCES = [
  'PATROL',
  'SHIFT_HANDOVER',
  'SECURITY_FINDING',
  'INCIDENT_READINESS',
] as const;

export type SecurityOperationalDetailSource =
  (typeof SECURITY_OPERATIONAL_DETAIL_SOURCES)[number];

export function isSecurityOperationalDetailSource(
  value: unknown,
): value is SecurityOperationalDetailSource {
  return (
    typeof value === 'string' &&
    (SECURITY_OPERATIONAL_DETAIL_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * R11 PART 03C — the frozen PURCHASE_ORDER_REGISTER `view` vocabulary.
 *
 * ONE dataset, TWO source-owned grains, exactly ONE selected table per
 * response: HEADER is one row per `purchase_orders` record (the existing
 * purchase-orders public list read) and LINE is one row per
 * `purchase_order_lines` record (the R11 PART 03B set-based line register).
 * `view` is REQUIRED — there is no default view, no implicit HEADER and no
 * inference from which filters happen to be present; the registry reader
 * rejects everything outside this two-member vocabulary with a validation
 * error. Declared once here, mirroring SECURITY_OPERATIONAL_DETAIL_SOURCES.
 */
export const PURCHASE_ORDER_REGISTER_VIEWS = ['HEADER', 'LINE'] as const;

export type PurchaseOrderRegisterView =
  (typeof PURCHASE_ORDER_REGISTER_VIEWS)[number];

export function isPurchaseOrderRegisterView(
  value: unknown,
): value is PurchaseOrderRegisterView {
  return (
    typeof value === 'string' &&
    (PURCHASE_ORDER_REGISTER_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * R11 PART 06 — the frozen OPERATIONAL_BUDGET_VARIANCE `view` vocabulary.
 *
 * ONE dataset, TWO source-owned grains, exactly ONE selected table per
 * response: BUDGET is one row per budget-level variance summary (the
 * existing operational-finance variance list read,
 * `operationalVarianceService.listOperationalBudgetVariance`) and CATEGORY
 * is one row per persisted budget category (the `categories` child grain of
 * the single-budget variance detail read,
 * `operationalVarianceService.getOperationalBudgetVariance`, addressed by a
 * REQUIRED budgetId). `view` is REQUIRED — there is no default view, no
 * implicit BUDGET and no inference from which filters happen to be present;
 * the registry reader rejects everything outside this two-member vocabulary
 * with a validation error. Declared once here, mirroring
 * PURCHASE_ORDER_REGISTER_VIEWS.
 */
export const OPERATIONAL_BUDGET_VARIANCE_VIEWS = ['BUDGET', 'CATEGORY'] as const;

export type OperationalBudgetVarianceView =
  (typeof OPERATIONAL_BUDGET_VARIANCE_VIEWS)[number];

export function isOperationalBudgetVarianceView(
  value: unknown,
): value is OperationalBudgetVarianceView {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_BUDGET_VARIANCE_VIEWS as readonly string[]).includes(value)
  );
}

/** Dataset-owned presentation policy consumed by shared renderers. */
export type ReportingExportDatasetMetadata = {
  /** Default CSV table used only when the caller omits tableKey. */
  csvDefaultTableKey?: string;
};

/**
 * Dataset export definitions. An unset entry preserves the generic renderer
 * contract; only OPERATIONAL_DETAIL owns a legacy CSV default.
 */
export const REPORTING_EXPORT_DATASET_METADATA: Partial<
  Record<ReportingExportDataset, ReportingExportDatasetMetadata>
> = {
  OPERATIONAL_DETAIL: {
    csvDefaultTableKey: 'operationalDetail',
  },
};

/** Column value types a consumer needs in order to format a cell. */
export const REPORTING_EXPORT_COLUMN_TYPES = [
  'STRING',
  'NUMBER',
  'PERCENT',
  'DATE',
  'BOOLEAN',
] as const;

export type ReportingExportColumnType =
  (typeof REPORTING_EXPORT_COLUMN_TYPES)[number];

/**
 * One column definition. `key` indexes into every row object of the same
 * table, so a consumer can emit a header row and then project each row in
 * a stable order without inspecting the data.
 */
export type ReportingExportColumn = {
  key: string;
  label: string;
  type: ReportingExportColumnType;
};

/** A single row: keys correspond to the table's column `key`s. */
export type ReportingExportRow = Record<
  string,
  string | number | boolean | null
>;

/**
 * A structured table. A dataset may expose several — for example the
 * workforce export carries both a summary table and a per-member table.
 */
export type ReportingExportTable = {
  /** Stable machine name, e.g. `patrolDaily`. */
  key: string;
  /** Human-readable table title. */
  label: string;
  columns: ReportingExportColumn[];
  rows: ReportingExportRow[];
  rowCount: number;
};

/**
 * A single flat KPI value. This is the "KPI values" surface: a scalar
 * list that needs no traversal of a nested object, suitable for a
 * headline block above a table.
 */
export type ReportingExportKpiValue = {
  key: string;
  label: string;
  value: number | string | null;
  type: ReportingExportColumnType;
};

/** Period and filter metadata describing exactly what was exported. */
export type ReportingExportMetadata = {
  dataset: ReportingExportDataset;
  datasetLabel: string;
  /** Null when the export is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included, as reported by the KPI service. */
  buildingScope: string[];
  period: {
    dateFrom: string | null;
    dateTo: string | null;
  };
  /**
   * The filters the KPI service actually applied, echoed back so an
   * exported file can state its own provenance. Only keys the caller
   * supplied (or the KPI defaulted) appear.
   */
  filters: Record<string, string | number | boolean | null>;
  /** Optional dataset-owned default used only when CSV tableKey is omitted. */
  csvDefaultTableKey?: string;
  /**
   * The KPI's own evaluation instant. Distinct from `generatedAt`:
   * `asOf` is when the underlying figures were measured, `generatedAt`
   * is when this envelope was produced.
   */
  asOf: string | null;
};

export type PublicReportingExport = {
  metadata: ReportingExportMetadata;
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
  /** When this export envelope was generated. */
  generatedAt: string;
};

/** Query filters accepted by the export endpoint. */
export type ReportingExportFilters = {
  dataset: ReportingExportDataset;
  buildingId?: string;
  dateFrom?: string;
  dateTo?: string;
  /**
   * Dataset-specific pass-through parameters. Validated by the owning
   * BE-23 KPI module's own parser, never re-interpreted here.
   */
  passThrough: Record<string, unknown>;
};
