import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { isFindingSourceType, isFindingStatus } from '../findings';
import { isReviewDecision } from '../reviews';
import { findingRegisterRepository } from './finding-register.repository';
import type {
  FindingRegisterFilters,
  PublicFindingRegister,
} from './finding-register.types';

/**
 * CR-BE-REPORT-READ-02 PART 01 — Finding Register service.
 *
 * Read-only. Internal backend read contract for Reporting consumption —
 * there is deliberately no HTTP endpoint in this PART; service-level reuse
 * is sufficient.
 *
 * SCOPE — mirrors the BE-23H read-model behavior exactly (and the sibling
 * Vendor Service Register in R01): an explicit `buildingId` is
 * existence-checked and access-asserted; an omitted one rolls the register
 * up across exactly the Buildings the caller can reach, so cross-Building
 * and cross-Client leakage is impossible; an empty authorized scope
 * returns a well-formed empty register rather than a 403.
 *
 * FILTERS — UUID identity filters plus the authorities' own verbatim
 * status/decision/source-type values (validated by the authorities' own
 * validators, never reinterpreted) and the BE-23H UTC half-open
 * date-window convention applied to `reported_at`.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseFindingRegisterQuery(
  query: Record<string, unknown>,
): FindingRegisterFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const classificationId = readOptionalUuid(
    query.classificationId,
    'classificationId',
    details,
  );
  const severityId = readOptionalUuid(query.severityId, 'severityId', details);
  const assignedUserId = readOptionalUuid(
    query.assignedUserId,
    'assignedUserId',
    details,
  );
  // `sourceId` is a UUID identity filter over `findings.source_id`, parsed
  // with the same convention as classificationId/severityId. It is
  // INDEPENDENT of the `sourceType` enum read below: neither is inferred
  // from the other, and both are simply conjunctive when supplied together.
  const sourceId = readOptionalUuid(query.sourceId, 'sourceId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isFindingStatus,
    'status must be a valid Finding status.',
    details,
  );
  const sourceType = readOptionalEnum(
    query.sourceType,
    'sourceType',
    isFindingSourceType,
    'sourceType must be a valid Finding source type.',
    details,
  );
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
    ...(classificationId === undefined ? {} : { classificationId }),
    ...(severityId === undefined ? {} : { severityId }),
    ...(assignedUserId === undefined ? {} : { assignedUserId }),
    ...(status === undefined ? {} : { status }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(verificationDecision === undefined ? {} : { verificationDecision }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the register window into a half-open [start, end) range over
 * `reported_at`. A date-only `dateTo` is inclusive of that whole UTC day.
 * Mirrors `vendorServiceRegisterRange` / BE-23H.
 */
export function findingRegisterRange(filters: FindingRegisterFilters): {
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
  filters: FindingRegisterFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = findingRegisterRange(filters);
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

export async function getFindingRegister(
  filters: FindingRegisterFilters,
  userId: string,
): Promise<PublicFindingRegister> {
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

  const rows = await findingRegisterRepository.getFindingRegisterRows(
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

export const findingRegisterService = {
  getFindingRegister,
  parseFindingRegisterQuery,
  findingRegisterRange,
};
