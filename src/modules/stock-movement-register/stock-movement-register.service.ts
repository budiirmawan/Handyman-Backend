import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { isStockMovementType } from '../inventory-stock-movements';
import { stockMovementRegisterRepository } from './stock-movement-register.repository';
import type {
  PublicStockMovementRegister,
  StockMovementRegisterFilters,
} from './stock-movement-register.types';

/**
 * R11 PART 05B — Stock Movement Register service.
 *
 * Read-only. Internal backend read contract for Reporting consumption —
 * there is deliberately no HTTP endpoint, no route, no controller and no
 * permission vocabulary in this PART; service-level reuse by the future
 * STOCK_MOVEMENT_REGISTER adapter (a later R11 PART, behind the EXISTING
 * `inventory_stock.read`) is sufficient. This service is NOT the stock
 * movements system of record and replaces none of the owning module's
 * reads: the movements ledger stays append-only and immutable under
 * `inventory-stock-movements`, whose public list keeps its own operational
 * purpose. What this service adds is the ONE thing the existing public
 * list lacks for Reporting: a set-based, actor-access-scoped, fail-closed,
 * governed-window read — exactly one repository query, never an unscoped
 * cross-client ledger dump.
 *
 * SCOPE — mirrors the proven R11 PART 01 receiving-register and PART 03B
 * purchase-order-line-register behavior exactly: an explicit `buildingId`
 * is existence-checked and access-asserted; an omitted one rolls the
 * register up across exactly the Buildings the caller can reach; an empty
 * authorized scope returns a well-formed empty register WITHOUT touching
 * the database rather than a 403. `userId` is REQUIRED — there is no
 * optional-actor form and no unscoped read path. No caller-supplied
 * clientId, no all-client fallback.
 *
 * FILTERS — the smallest source-backed set: UUID identity filters
 * (buildingId, warehouseId, itemId, performedByUserId) validated and
 * normalized; `movementType` validated by the movements authority's OWN
 * validator (`isStockMovementType`) and never reinterpreted — the native
 * STOCK_IN / STOCK_OUT vocabulary is preserved verbatim and there is no
 * generic lifecycle field on this contract; the persisted generic
 * `reference` text under the owning domain's own substring semantics.
 * Nothing else is accepted — no clientId, search, receivingId,
 * purchaseOrderId, purchaseOrderLineId, materialRequestId, workOrderId,
 * vendorId, reservationId, cost or value filters, page, limit, latestOnly
 * or currentOnly: columns existing somewhere is not a reason to widen
 * this contract.
 *
 * PERIOD — `dateFrom`/`dateTo` are strict real `YYYY-MM-DD` calendar dates
 * applied to `movement_date` (TIMESTAMPTZ), the movement business period
 * authority, under the established bounded Reporting timestamp-window
 * convention (BE-23H): normalized to the half-open UTC range
 * `>= startOf(dateFrom)` and `< startOf(dayAfter(dateTo))`, so the entire
 * `dateTo` calendar day is included. The existing public list's raw
 * `new Date(string)` parsing and its `<= dateTo-midnight` truncation
 * defect are deliberately NOT reused. `dateTo` must not precede
 * `dateFrom` and the span is bounded to 366 days, mirroring the R11
 * register reporting-safety bound. `created_at` is never a period
 * substitute.
 *
 * NO KPI, NO AGGREGATION, NO MONETARY AUTHORITY: quantity, uomId and the
 * persisted historical post-movement snapshots stay per-row facts — never
 * summed across items or UOMs, never converted, never netted, never
 * re-resolved against the live stock-balance domain, and no reserved
 * quantity is derived by subtraction. The contract carries no monetary
 * field and consults no pricing, invoice, receiving or usage authority.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseStockMovementRegisterQuery(
  query: Record<string, unknown>,
): StockMovementRegisterFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const warehouseId = readOptionalUuid(query.warehouseId, 'warehouseId', details);
  const itemId = readOptionalUuid(query.itemId, 'itemId', details);
  const performedByUserId = readOptionalUuid(
    query.performedByUserId,
    'performedByUserId',
    details,
  );

  const movementType = readOptionalEnum(
    query.movementType,
    'movementType',
    isStockMovementType,
    'movementType must be a valid stock movement type.',
    details,
  );

  const dateFrom = readOptionalCalendarDate(query.dateFrom, 'dateFrom', details);
  const dateTo = readOptionalCalendarDate(query.dateTo, 'dateTo', details);

  if (dateFrom && dateTo && dateTo < dateFrom) {
    details.push({
      field: 'dateTo',
      message: 'dateTo must be the same as or after dateFrom.',
    });
  }
  if (dateFrom && dateTo) {
    const spanDays =
      (toUtcMidnight(dateTo).getTime() - toUtcMidnight(dateFrom).getTime()) /
      86400000;
    if (spanDays > MAX_RANGE_DAYS) {
      details.push({
        field: 'dateTo',
        message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
      });
    }
  }

  const referenceRaw = readSingleParam(query.reference);
  const reference =
    referenceRaw === undefined || referenceRaw.trim() === ''
      ? undefined
      : referenceRaw.trim();

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(warehouseId === undefined ? {} : { warehouseId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(movementType === undefined ? {} : { movementType }),
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
    ...(performedByUserId === undefined ? {} : { performedByUserId }),
    ...(reference === undefined ? {} : { reference }),
  };
}

/**
 * Converts the register window into a half-open [start, end) range over
 * `movement_date` (TIMESTAMPTZ). Both inputs are strict real YYYY-MM-DD
 * calendar dates, so `dateTo` always includes its whole UTC day: the end
 * bound is the NEXT day's UTC midnight, never a `<= dateTo-midnight`
 * truncation. Mirrors `receivingRegisterRange` (BE-23H convention).
 */
export function stockMovementRegisterRange(
  filters: StockMovementRegisterFilters,
): { start: Date | null; end: Date | null } {
  const start = filters.dateFrom ? toUtcMidnight(filters.dateFrom) : null;
  const end = filters.dateTo
    ? new Date(toUtcMidnight(filters.dateTo).getTime() + 86400000)
    : null;
  return { start, end };
}

async function resolveScope(
  filters: StockMovementRegisterFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = stockMovementRegisterRange(filters);
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return {
      start: range.start,
      end: range.end,
      buildingIds: [filters.buildingId],
    };
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    userId,
  );
  return { start: range.start, end: range.end, buildingIds };
}

export async function getStockMovementRegister(
  filters: StockMovementRegisterFilters,
  userId: string,
): Promise<PublicStockMovementRegister> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    // Truthful window metadata: the accepted strict calendar dates, as
    // given. The query applies the normalized half-open UTC window over
    // `movement_date` from stockMovementRegisterRange — start inclusive,
    // next-day-after-dateTo exclusive.
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed empty register rather
  // than a 403, and without touching the database at all.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const rows = await stockMovementRegisterRepository.getStockMovementRegisterRows(
    buildingIds,
    filters,
    start,
    end,
  );

  return { ...base, rows };
}

function readOptionalCalendarDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const normalized = raw.trim();
  if (!DATE_ONLY.test(normalized) || !isCalendarDate(normalized)) {
    details.push({
      field,
      message: `${field} must be a valid YYYY-MM-DD date.`,
    });
    return undefined;
  }
  return normalized;
}

/** True when the YYYY-MM-DD triple is a real calendar date (leap years included). */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function toUtcMidnight(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

function readOptionalEnum(
  value: unknown,
  field: string,
  isValid: (candidate: unknown) => boolean,
  message: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const normalized = raw.trim().toUpperCase();
  if (!isValid(normalized)) {
    details.push({ field, message });
    return undefined;
  }
  return normalized;
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

export const stockMovementRegisterService = {
  getStockMovementRegister,
  parseStockMovementRegisterQuery,
  stockMovementRegisterRange,
};
