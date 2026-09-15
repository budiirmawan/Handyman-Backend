import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  isBastRequirement,
  isWorkOrderPriority,
  isWorkOrderStatus,
} from '../work-orders';
import { isReviewDecision } from '../reviews';
import { workOrderRegisterRepository } from './work-order-register.repository';
import type {
  PublicWorkOrderRegister,
  WorkOrderRegisterFilters,
} from './work-order-register.types';

/**
 * CR-BE-REPORT-READ-03 PART 01 — Work Order Register service.
 *
 * Read-only. Internal backend read contract for Reporting consumption —
 * there is deliberately no HTTP endpoint in this PART; service-level reuse
 * is sufficient.
 *
 * SCOPE — mirrors the BE-23H read-model behavior exactly (and the sibling
 * Vendor Service Register / Finding Register): an explicit `buildingId`
 * is existence-checked and access-asserted; an omitted one rolls the
 * register up across exactly the Buildings the caller can reach, so
 * cross-Building and cross-Client leakage is impossible; an empty
 * authorized scope returns a well-formed empty register rather than a 403.
 *
 * FILTERS — UUID identity filters plus the authorities' own verbatim
 * status/priority/bast/decision values (validated against the authority
 * enums, never reinterpreted) and the BE-23H UTC half-open date-window
 * convention applied to `created_at` (Work Orders have no reported_at;
 * `created_at` is the neutral origination timestamp used by the
 * management-work-order-summary KPI).
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseWorkOrderRegisterQuery(
  query: Record<string, unknown>,
): WorkOrderRegisterFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const assetId = readOptionalUuid(query.assetId, 'assetId', details);
  const assignedUserId = readOptionalUuid(
    query.assignedUserId,
    'assignedUserId',
    details,
  );
  const assignedTeamId = readOptionalUuid(
    query.assignedTeamId,
    'assignedTeamId',
    details,
  );
  const vendorId = readOptionalUuid(query.vendorId, 'vendorId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isWorkOrderStatus,
    'status must be a valid Work Order status.',
    details,
  );
  const priority = readOptionalEnum(
    query.priority,
    'priority',
    isWorkOrderPriority,
    'priority must be a valid Work Order priority.',
    details,
  );
  const bastRequirement = readOptionalEnum(
    query.bastRequirement,
    'bastRequirement',
    isBastRequirement,
    'bastRequirement must be a valid BAST requirement.',
    details,
  );
  const workType = readSingleParam(query.workType);
  const verificationDecision = readOptionalEnum(
    query.verificationDecision,
    'verificationDecision',
    isReviewDecision,
    'verificationDecision must be a valid review decision.',
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
    details.push({ field: 'dateFrom', message: 'dateFrom must not exceed dateTo.' });
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
    ...(assetId === undefined ? {} : { assetId }),
    ...(assignedUserId === undefined ? {} : { assignedUserId }),
    ...(assignedTeamId === undefined ? {} : { assignedTeamId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(status === undefined ? {} : { status }),
    ...(priority === undefined ? {} : { priority }),
    ...(bastRequirement === undefined ? {} : { bastRequirement }),
    ...(workType ? { workType: workType.trim() } : {}),
    ...(verificationDecision === undefined ? {} : { verificationDecision }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the register window into a half-open [start, end) range over
 * `created_at`. A date-only `dateTo` is inclusive of that whole UTC day.
 * Mirrors `vendorServiceRegisterRange` / BE-23H.
 */
export function workOrderRegisterRange(filters: WorkOrderRegisterFilters): {
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
  filters: WorkOrderRegisterFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = workOrderRegisterRange(filters);
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

export async function getWorkOrderRegister(
  filters: WorkOrderRegisterFilters,
  userId: string,
): Promise<PublicWorkOrderRegister> {
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

  const rows = await workOrderRegisterRepository.getWorkOrderRegisterRows(
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

// Unused-constant guard: none needed; validators directly reference enums.

export const workOrderRegisterService = {
  getWorkOrderRegister,
  parseWorkOrderRegisterQuery,
  workOrderRegisterRange,
};
