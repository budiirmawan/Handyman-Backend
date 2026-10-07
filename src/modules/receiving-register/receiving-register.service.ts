import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { isReceivingStatus, isReceivingType } from '../receivings';
import { receivingRegisterRepository } from './receiving-register.repository';
import type {
  PublicReceivingRegister,
  ReceivingRegisterFilters,
} from './receiving-register.types';

/**
 * R11 PART 01 — Receiving Register service.
 *
 * Read-only. Internal backend read contract for Reporting consumption —
 * there is deliberately no HTTP endpoint in this PART; service-level reuse
 * is sufficient. This service is NOT the receivings system of record and
 * does not replace any receivings module read: it re-presents persisted
 * receiving facts for the future RECEIVING_REGISTER dataset.
 *
 * SCOPE — mirrors the proven CR-BE-REPORT-READ-01 register behavior
 * exactly: an explicit `buildingId` is existence-checked and
 * access-asserted; an omitted one rolls the register up across exactly the
 * Buildings the caller can reach, so cross-Building and cross-Client
 * leakage is impossible; an empty authorized scope returns a well-formed
 * empty register rather than a 403.
 *
 * FILTERS — UUID identity filters plus the receivings authority's own
 * verbatim type/status vocabularies (validated by the authority's own
 * validators, never reinterpreted) and the BE-23H UTC half-open
 * date-window convention applied to `received_at`, the receiving business
 * period authority. No filter exists — and none may be added here — that
 * would require inferring a purchase order, a purchase order line, an
 * invoice or a work order relationship: the schema persists none of those
 * on a receiving row.
 *
 * NO KPI, NO AGGREGATION: quantities stay per-row facts (never summed
 * across items or UOMs); the contract carries no monetary field.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseReceivingRegisterQuery(
  query: Record<string, unknown>,
): ReceivingRegisterFilters {
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

  const receivingType = readOptionalEnum(
    query.receivingType,
    'receivingType',
    isReceivingType,
    'receivingType must be a valid receiving type.',
    details,
  );
  const status = readOptionalEnum(
    query.status,
    'status',
    isReceivingStatus,
    'status must be a valid receiving status.',
    details,
  );

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw
    ? readOptionalDate(dateToRaw, 'dateTo', details)
    : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({
      field: 'dateFrom',
      message: 'dateFrom must not exceed dateTo.',
    });
  }
  if (
    dateFrom &&
    dateTo &&
    (dateTo.getTime() - dateFrom.getTime()) / 86400000 > MAX_RANGE_DAYS
  ) {
    details.push({
      field: 'dateTo',
      message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
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
    ...(receivingType === undefined ? {} : { receivingType }),
    ...(status === undefined ? {} : { status }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the register window into a half-open [start, end) range over
 * `received_at`. A date-only `dateTo` is inclusive of that whole UTC day.
 * Mirrors `vendorServiceRegisterRange`.
 */
export function receivingRegisterRange(filters: ReceivingRegisterFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo)
      ? new Date(to.getTime() + 86400000)
      : to;
  }
  return { start, end };
}

async function resolveScope(
  filters: ReceivingRegisterFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = receivingRegisterRange(filters);
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

export async function getReceivingRegister(
  filters: ReceivingRegisterFilters,
  userId: string,
): Promise<PublicReceivingRegister> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed empty register rather
  // than a 403, matching the BE-23 reporting convention.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const rows = await receivingRegisterRepository.getReceivingRegisterRows(
    buildingIds,
    filters,
    start,
    end,
  );

  return { ...base, rows };
}

function readOptionalDate(
  raw: string,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date or datetime.`,
    });
    return undefined;
  }
  return parsed;
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

export const receivingRegisterService = {
  getReceivingRegister,
  parseReceivingRegisterQuery,
  receivingRegisterRange,
};
