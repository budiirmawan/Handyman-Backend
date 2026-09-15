import type { PublicEsgMetricValue } from '../esg-metric-values';
import type { PublicEsgWasteRecord } from '../esg-waste-records';
import type { PublicUtilityConsumptionTrendBucket } from '../utility-meter-consumptions';
import type { PublicPortfolioOperationalComparisonRow } from './reporting-export.types';
import type {
  ReportingExportColumn,
  ReportingExportKpiValue,
  ReportingExportTable,
} from './reporting-export.types';

const STRING = 'STRING' as const;
const NUMBER = 'NUMBER' as const;
const DATE = 'DATE' as const;

function table(
  key: string,
  label: string,
  columns: ReportingExportColumn[],
  rows: ReportingExportTable['rows'],
): ReportingExportTable {
  return { key, label, columns, rows, rowCount: rows.length };
}

/**
 * R12 PART 02 — a pure projection of the governed ESG metric-value read.
 *
 * The source owns actor scope, complete-period containment, persisted value
 * semantics and native provenance. This adapter only renames the source id
 * for the Reporting contract and copies the approved fields at source grain.
 */
export function projectEsgMetricTrend(
  source: PublicEsgMetricValue[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const columns: ReportingExportColumn[] = [
    { key: 'metricValueId', label: 'Metric Value Id', type: STRING },
    { key: 'buildingId', label: 'Building Id', type: STRING },
    { key: 'metricDefinitionId', label: 'Metric Definition Id', type: STRING },
    { key: 'periodType', label: 'Period Type', type: STRING },
    { key: 'periodStart', label: 'Period Start', type: DATE },
    { key: 'periodEnd', label: 'Period End', type: DATE },
    { key: 'value', label: 'Value', type: NUMBER },
    { key: 'uomId', label: 'UOM Id', type: STRING },
    { key: 'dataQuality', label: 'Data Quality', type: STRING },
    { key: 'verificationStatus', label: 'Verification Status', type: STRING },
    { key: 'sourceType', label: 'Source Type', type: STRING },
    { key: 'calculationMethod', label: 'Calculation Method', type: STRING },
  ];

  return {
    kpis: [],
    tables: [
      table(
        'esgMetricTrend',
        'ESG Metric Trend',
        columns,
        source.map((row) => ({
          metricValueId: row.id,
          buildingId: row.buildingId,
          metricDefinitionId: row.metricDefinitionId,
          periodType: row.periodType,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          value: row.value,
          uomId: row.uomId,
          dataQuality: row.dataQuality,
          verificationStatus: row.verificationStatus,
          sourceType: row.sourceType,
          calculationMethod: row.calculationMethod,
        })),
      ),
    ],
  };
}

/**
 * R12 PART 03 — a pure source-grain projection of the bounded ESG waste read.
 *
 * Waste quantity and UOM remain persisted facts. No carbon, conversion,
 * aggregation, date synthesis or cross-record inference is performed here.
 */
export function projectEsgWasteRegister(
  source: PublicEsgWasteRecord[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const columns: ReportingExportColumn[] = [
    { key: 'wasteRecordId', label: 'Waste Record Id', type: STRING },
    { key: 'buildingId', label: 'Building Id', type: STRING },
    { key: 'periodDate', label: 'Period Date', type: DATE },
    { key: 'wasteType', label: 'Waste Type', type: STRING },
    { key: 'disposalMethod', label: 'Disposal Method', type: STRING },
    { key: 'quantity', label: 'Quantity', type: NUMBER },
    { key: 'uomId', label: 'UOM Id', type: STRING },
    { key: 'status', label: 'Status', type: STRING },
  ];

  return {
    kpis: [],
    tables: [
      table(
        'esgWasteRegister',
        'ESG Waste Register',
        columns,
        source.map((row) => ({
          wasteRecordId: row.id,
          buildingId: row.buildingId,
          periodDate: row.periodDate,
          wasteType: row.wasteType,
          disposalMethod: row.disposalMethod,
          quantity: row.quantity,
          uomId: row.uomId,
          status: row.status,
        })),
      ),
    ],
  };
}

/**
 * R12 PART 04 — a pure presentation of source-owned utility trend buckets.
 *
 * Grouping, persisted-value summation and UOM separation are completed by the
 * utility source read. Reporting only copies the bounded bucket facts.
 */
export function projectUtilityConsumptionTrend(
  source: PublicUtilityConsumptionTrendBucket[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const columns: ReportingExportColumn[] = [
    { key: 'buildingId', label: 'Building Id', type: STRING },
    { key: 'periodStart', label: 'Period Start', type: DATE },
    { key: 'periodEnd', label: 'Period End', type: DATE },
    { key: 'interval', label: 'Interval', type: STRING },
    { key: 'utilityType', label: 'Utility Type', type: STRING },
    { key: 'uomId', label: 'UOM Id', type: STRING },
    { key: 'consumptionValue', label: 'Consumption Value', type: NUMBER },
  ];

  return {
    kpis: [],
    tables: [
      table(
        'utilityConsumptionTrend',
        'Utility Consumption Trend',
        columns,
        source.map((row) => ({
          buildingId: row.buildingId,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          interval: row.interval,
          utilityType: row.utilityType,
          uomId: row.uomId,
          consumptionValue: row.consumptionValue,
        })),
      ),
    ],
  };
}

/**
 * R12 PART 05 — a pure comparison presentation of absolute source-row counts.
 * No normalization, ranking, score, lifecycle reconstruction or denominator is
 * introduced; zero-count combinations are intentionally absent.
 */
export function projectPortfolioOperationalComparison(
  source: PublicPortfolioOperationalComparisonRow[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  const columns: ReportingExportColumn[] = [
    { key: 'buildingId', label: 'Building Id', type: STRING },
    { key: 'metric', label: 'Metric', type: STRING },
    { key: 'value', label: 'Value', type: NUMBER },
    { key: 'periodStart', label: 'Period Start', type: DATE },
    { key: 'periodEnd', label: 'Period End', type: DATE },
  ];

  return {
    kpis: [],
    tables: [
      table(
        'portfolioOperationalComparison',
        'Portfolio Operational Comparison',
        columns,
        source.map((row) => ({
          buildingId: row.buildingId,
          metric: row.metric,
          value: row.value,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
        })),
      ),
    ],
  };
}
