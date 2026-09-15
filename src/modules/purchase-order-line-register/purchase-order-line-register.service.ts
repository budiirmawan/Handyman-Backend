import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { isPurchaseOrderStatus } from '../purchase-orders';
import { purchaseOrderLineRegisterRepository } from './purchase-order-line-register.repository';
import type {
  PublicPurchaseOrderLineRegister,
  PurchaseOrderLineRegisterFilters,
} from './purchase-order-line-register.types';

/**
 * R11 PART 03B — Purchase Order Line Register service.
 *
 * Read-only. Internal backend read contract for Reporting consumption —
 * there is deliberately no HTTP endpoint, no route, no controller and no
 * permission vocabulary in this PART; service-level reuse by the future
 * PURCHASE_ORDER_REGISTER adapter (R11 PART 03C, behind the EXISTING
 * `purchase_order.read`) is sufficient. This service is NOT the
 * purchase-orders system of record and replaces none of its reads: the
 * HEADER view stays owned by `listPurchaseOrders`, and the per-PO public
 * line read (`listPurchaseOrderLines`) keeps its own operational purpose.
 * What this service adds is the ONE thing the existing authorities lack: a
 * set-based, access-scoped, cross-PO LINE read — exactly one repository
 * query, never a list → loop → per-PO-fetch N+1.
 *
 * SCOPE — mirrors the proven R11 PART 01 receiving-register behavior
 * exactly: an explicit `buildingId` is existence-checked and
 * access-asserted; an omitted one rolls the register up across exactly the
 * Buildings the caller can reach; an empty authorized scope returns a
 * well-formed empty register without touching the database rather than a
 * 403. No caller-supplied clientId, no all-client fallback.
 *
 * FILTERS — the smallest source-backed set for the LINE view: the common
 * purchase-order filters (buildingId, vendorId, purchaseRequestId,
 * serviceRequestId, status, dateFrom, dateTo) plus the two LINE-specific
 * ones (materialRequestId, itemId). UUID filters are validated and
 * normalized; `status` is validated by the purchase-orders authority's OWN
 * validator (`isPurchaseOrderStatus`) and never reinterpreted; the status,
 * request-line-type and currency vocabularies stay the source's native
 * ones. Nothing else is accepted — no receivingId, invoiceId, workOrderId,
 * rfqId, rfqStatus, priceDeviationStatus, poNumber, requestType, search,
 * latestOnly, currentOnly, page or limit: columns existing somewhere is
 * not a reason to widen this contract.
 *
 * PERIOD — `dateFrom`/`dateTo` are strict `YYYY-MM-DD` calendar dates
 * (the same shape the HEADER authority's own parser accepts for
 * `poDateFrom`/`poDateTo`) applied to the parent PO's `po_date` INCLUSIVE
 * on both ends: [dateFrom, dateTo]. `dateTo` must not precede `dateFrom`
 * and the span is bounded to 366 days, mirroring the R11 PART 01
 * reporting-safety bound. The bound limits the window; it never changes
 * the inclusive DATE meaning.
 *
 * NO KPI, NO AGGREGATION, NO MONETARY ARITHMETIC: quantitySnapshot,
 * unitPrice and lineAmount stay per-row persisted facts; no PO total is
 * summed, no amount is recomputed, no currency is converted and no price
 * catalog is consulted.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parsePurchaseOrderLineRegisterQuery(
  query: Record<string, unknown>,
): PurchaseOrderLineRegisterFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const vendorId = readOptionalUuid(query.vendorId, 'vendorId', details);
  const purchaseRequestId = readOptionalUuid(
    query.purchaseRequestId,
    'purchaseRequestId',
    details,
  );
  const serviceRequestId = readOptionalUuid(
    query.serviceRequestId,
    'serviceRequestId',
    details,
  );
  const materialRequestId = readOptionalUuid(
    query.materialRequestId,
    'materialRequestId',
    details,
  );
  const itemId = readOptionalUuid(query.itemId, 'itemId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isPurchaseOrderStatus,
    'status must be a valid purchase order status.',
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

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(purchaseRequestId === undefined ? {} : { purchaseRequestId }),
    ...(serviceRequestId === undefined ? {} : { serviceRequestId }),
    ...(materialRequestId === undefined ? {} : { materialRequestId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(status === undefined ? {} : { status }),
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
  };
}

async function resolveScope(
  filters: PurchaseOrderLineRegisterFilters,
  userId: string,
): Promise<string[]> {
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return [filters.buildingId];
  }
  return contextAccessService.getAccessibleBuildingIds(userId);
}

export async function getPurchaseOrderLineRegister(
  filters: PurchaseOrderLineRegisterFilters,
  userId: string,
): Promise<PublicPurchaseOrderLineRegister> {
  const buildingIds = await resolveScope(filters, userId);
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    // Truthful window metadata: inclusive calendar dates over the parent
    // PO's `po_date` — never a half-open timestamp claim.
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed empty register rather
  // than a 403, and without touching the database at all.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const rows =
    await purchaseOrderLineRegisterRepository.getPurchaseOrderLineRegisterRows(
      buildingIds,
      filters,
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

export const purchaseOrderLineRegisterService = {
  getPurchaseOrderLineRegister,
  parsePurchaseOrderLineRegisterQuery,
};
