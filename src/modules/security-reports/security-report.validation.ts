import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { SecurityReportFilters } from './security-report.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;

export const POST_REPORT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const ROUTE_REPORT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const PATROL_REPORT_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export const EXECUTION_REPORT_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export const HANDOVER_REPORT_STATUSES = [
  'DRAFT',
  'READY',
  'ACKNOWLEDGED',
  'CANCELLED',
] as const;
export const INCIDENT_READINESS_REPORT_STATUSES = [
  'NOT_READY',
  'PARTIAL',
  'READY',
] as const;
export const VISITOR_BINDING_REPORT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export const KEY_REPORT_STATUSES = [
  'AVAILABLE',
  'ISSUED',
  'OVERDUE',
  'LOST',
  'INACTIVE',
] as const;
export const LOST_FOUND_REPORT_STATUSES = [
  'FOUND',
  'IN_CUSTODY',
  'CLAIMED',
  'RETURNED',
  'DISPOSED',
  'CLOSED',
] as const;
export const BINDING_REPORT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const FINDING_REPORT_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REJECTED',
  'REWORK_REQUIRED',
  'RESUBMITTED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
] as const;

/**
 * Parse the shared Security report query string.
 *
 * `buildingId` is REQUIRED for every dataset endpoint. The summary
 * endpoint accepts an OMITTED `buildingId` to mean "roll up across
 * every building the caller can access" — that case is handled by
 * the service (which sees `buildingId: undefined` and switches to
 * the accessible-buildings path).
 */
export function parseReportQuery(
  query: Record<string, unknown>,
  options: { allowedStatuses?: readonly string[] } = {},
): SecurityReportFilters {
  const details: ValidationDetail[] = [];

  const buildingIdRaw = readSingleParam(query.buildingId);
  let buildingId: string | undefined;
  if (buildingIdRaw === undefined || buildingIdRaw === '') {
    // Optional — only the summary endpoint allows omission.
  } else if (!isValidUuid(buildingIdRaw.trim())) {
    details.push({
      field: 'buildingId',
      message: 'buildingId must be a valid UUID.',
    });
  } else {
    buildingId = buildingIdRaw.trim().toLowerCase();
  }

  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );
  const patrolRouteId = readOptionalUuid(
    query.patrolRouteId,
    'patrolRouteId',
    details,
  );
  const workforceId = readOptionalUuid(
    query.workforceId,
    'workforceId',
    details,
  );
  const teamId = readOptionalUuid(query.teamId, 'teamId', details);

  let status: string | undefined;
  const rawStatus = readSingleParam(query.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    const normalized = rawStatus.trim().toUpperCase();
    if (
      options.allowedStatuses &&
      !options.allowedStatuses.includes(normalized)
    ) {
      details.push({
        field: 'status',
        message: `status must be one of: ${options.allowedStatuses.join(', ')}.`,
      });
    } else {
      status = normalized;
    }
  }

  let custodyStatus: string | undefined;
  const rawCustodyStatus = readSingleParam(query.custodyStatus);
  if (rawCustodyStatus !== undefined && rawCustodyStatus !== '') {
    const normalized = rawCustodyStatus.trim().toUpperCase();
    if (
      options.allowedStatuses &&
      !options.allowedStatuses.includes(normalized)
    ) {
      details.push({
        field: 'custodyStatus',
        message: `custodyStatus must be one of: ${options.allowedStatuses.join(', ')}.`,
      });
    } else {
      custodyStatus = normalized;
    }
  }

  let category: string | undefined;
  const rawCategory = readSingleParam(query.category);
  if (rawCategory !== undefined && rawCategory !== '') {
    category = rawCategory.trim().toUpperCase();
  }

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;
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
    ...(buildingId ? { buildingId } : {}),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(patrolRouteId === undefined ? {} : { patrolRouteId }),
    ...(workforceId === undefined ? {} : { workforceId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(status === undefined ? {} : { status }),
    ...(custodyStatus === undefined ? {} : { custodyStatus }),
    ...(category === undefined ? {} : { category }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/** Converts report dateTo into an exclusive end (next day 00:00Z). */
export function reportRange(filters: SecurityReportFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo)) {
      end = new Date(to.getTime() + 86400000);
    } else {
      end = to;
    }
  }
  return { start, end };
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

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}
