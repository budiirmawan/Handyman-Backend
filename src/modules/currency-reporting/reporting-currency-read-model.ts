import { getPool } from '../../database';
import { buildingRepository } from '../buildings';
import { propertyRepository } from '../properties';
import { databaseFxRateGateway } from '../fx-rates/fx-conversion.gateway';
import {
  fxReportingService,
  type FxReportingMonetaryFact,
  type FxReportingCurrencyView,
} from '../fx-rates/fx-reporting.service';
import { getOperationalCurrencySummary } from './index';

/**
 * CR-BE-FX-01 PART 04 — reporting-currency read model over the existing
 * exact-currency operational seam.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §10, §1.2, §22, and PART 04
 * §1, §3, §5, §6, §12, §15.
 *
 * WHY THIS SURFACE. `getOperationalCurrencySummary` is the only monetary read
 * model in the repository that already groups by `currency_code` and keeps an
 * UNKNOWN bucket — i.e. the only one whose components are single-currency and
 * therefore mathematically safe to convert. It was built by CUR-01 for exactly
 * this purpose and is still unwired.
 *
 * WHY NOT THE OTHERS (recorded, not silently skipped):
 *   - `operational-finance-aggregation` and `operational-variance` are
 *     single-budget-currency OPERATIONAL CONTROLS with `failClosed` semantics.
 *     PART 04 §15 forbids using reporting FX to make a budget binding,
 *     commitment or actualization match, so no converted view is added there.
 *   - `management-operational-finance` is a projection of that same control
 *     aggregation, so it inherits the same exclusion.
 *   - `basic-financial-reporting` sums across tenant charges, utility bills,
 *     tenant invoices, payments, receipts, vendor service costs and basic
 *     expenses with NO currency grouping — a pre-existing mixed-currency
 *     aggregate. Converting on top of it would violate PART 04 §5, and
 *     re-grouping it by currency is a remediation well outside PART 04.
 *   - `reporting-export` contains no monetary data at all (zero `currency`
 *     references across every file), so there is nothing to integrate and the
 *     CSV/XLSX/PDF/JSON renderers stay pure consumers.
 *
 * NOTHING IS MUTATED. This module only reads. No converted amount is persisted,
 * no `fxRateId` is written to a transaction table, and no audit event is
 * emitted: provenance travels with the read result only.
 *
 * NOT RE-EXPORTED BY `./index.ts`, deliberately: this file imports
 * `getOperationalCurrencySummary` from the index, so re-exporting it there would
 * create an import cycle. Consumers import this file directly, which
 * `operational-finance` also does for some of its files. The existing seam is
 * left byte-identical.
 */

/** One FINALIZED operational cost fact, with its own business date. */
type MonetarySourceRow = {
  sourceType: string;
  sourceId: string;
  amount: string;
  currencyCode: string | null;
  businessDate: string | null;
};

async function resolveClientIdForBuilding(buildingId: string): Promise<string | null> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) return null;
  const property = await propertyRepository.findById(building.propertyId);
  return property?.clientId ?? null;
}

/**
 * Per-row projection of the same FINALIZED rows the exact-currency seam
 * aggregates, but keeping each row's own currency snapshot and business date so
 * every fact can be converted at ITS OWN date.
 *
 * The existing aggregate query is deliberately left untouched: PART 04 §3
 * requires the original-currency view to remain available unchanged.
 */
async function listOperationalMonetaryFacts(buildingId: string): Promise<MonetarySourceRow[]> {
  const sources = [
    {
      sourceType: 'VENDOR_SERVICE_COST',
      table: 'vendor_service_costs',
      amountColumn: 'cost_amount',
      dateColumn: 'cost_date',
    },
    {
      sourceType: 'BASIC_EXPENSE',
      table: 'basic_expenses',
      amountColumn: 'amount',
      dateColumn: 'expense_date',
    },
  ] as const;

  const rows = await Promise.all(
    sources.map((source) =>
      getPool()
        .query<{ id: string; amount: string; currencyCode: string | null; businessDate: string | null }>(
          `SELECT id::text AS id,
                  ${source.amountColumn}::text AS amount,
                  currency_code AS "currencyCode",
                  ${source.dateColumn}::text AS "businessDate"
           FROM ${source.table}
           WHERE building_id = $1 AND status = 'FINALIZED'
           ORDER BY ${source.dateColumn}, id`,
          [buildingId],
        )
        .then((result) =>
          result.rows.map<MonetarySourceRow>((row) => ({
            sourceType: source.sourceType,
            sourceId: row.id,
            amount: row.amount,
            currencyCode: row.currencyCode,
            // A NULL/empty business date is passed through as null; the reporting
            // layer puts it in the unconvertible bucket rather than inventing one.
            businessDate: row.businessDate === null || row.businessDate === '' ? null : row.businessDate,
          })),
        ),
    ),
  );

  return rows.flat();
}

export type OperationalCurrencyReport = {
  buildingId: string;
  clientId: string | null;
  /**
   * The authoritative exact-currency view, returned unchanged from the existing
   * CUR-01 seam. It is always present, whether or not anything converted.
   */
  originalCurrency: Awaited<ReturnType<typeof getOperationalCurrencySummary>>;
  /**
   * The additional converted view. `convertedTotal` is COMPLETE or null; a
   * partial total is never returned as a grand total.
   */
  reportingCurrency: FxReportingCurrencyView | null;
};

/**
 * Returns BOTH views side by side: the untouched original-currency groups and,
 * beside them, the governed reporting-currency view.
 *
 * The reporting currency comes from the Client FX Policy — never from a
 * hardcoded currency, a Building, a document type or request input.
 */
export async function getOperationalCurrencyReport(
  buildingId: string,
  actorUserId: string,
): Promise<OperationalCurrencyReport> {
  // Authorization is enforced by the CUR-01 seam this delegates to:
  // getOperationalCurrencySummary() calls
  // contextAccessService.assertBuildingAccess(actorUserId, buildingId) before
  // reading anything. It is called first, so no row is read for a Building the
  // caller cannot reach. The FX view below is built only from that same
  // Building's FINALIZED rows.
  const originalCurrency = await getOperationalCurrencySummary(buildingId, actorUserId);
  const clientId = await resolveClientIdForBuilding(buildingId);

  if (clientId === null) {
    // Without a resolvable Client there is no governed reporting currency, so
    // only the original-currency view is returned.
    return { buildingId, clientId: null, originalCurrency, reportingCurrency: null };
  }

  const facts = await listOperationalMonetaryFacts(buildingId);
  const reportingCurrency = await fxReportingService.buildReportingCurrencyView({
    clientId,
    facts: facts as FxReportingMonetaryFact[],
    gateway: databaseFxRateGateway,
  });

  return { buildingId, clientId, originalCurrency, reportingCurrency };
}

/** Re-exported so callers can build the view from their own facts if needed. */
export { fxReportingService };
export type { FxReportingCurrencyView, FxReportingMonetaryFact };
