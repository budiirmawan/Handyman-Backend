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
] as const;

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
