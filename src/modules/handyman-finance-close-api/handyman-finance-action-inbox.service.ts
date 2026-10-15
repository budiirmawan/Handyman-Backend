import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { handymanFinanceActionInboxRepository } from './handyman-finance-action-inbox.repository';
import {
  HANDYMAN_FINANCE_ACTION_INBOX_BLOCKER_CODES,
  HANDYMAN_FINANCE_ACTION_INBOX_CATEGORIES,
  HANDYMAN_FINANCE_ACTION_INBOX_RECORD_STATUSES,
  HANDYMAN_FINANCE_ACTION_INBOX_RECORD_TYPES,
  HANDYMAN_FINANCE_ACTION_INBOX_RESPONSIBLE_PERMISSIONS,
  type HandymanFinanceActionInboxCursor,
  type HandymanFinanceActionInboxQuery,
  type HandymanFinanceActionInboxRecordType,
  type HandymanFinanceActionInboxResult,
} from './handyman-finance-action-inbox.types';
import { assertOnlyKeys } from './handyman-finance-close-api.validation';

/**
 * CR-HM-FIN-DISCOVERY-02 P0-B — Authoritative Finance Action Inbox service.
 *
 * Enforces:
 *  - BE-02G Building-scoped access preamble (`403 BUILDING_ACCESS_DENIED` when
 *    the actor has no ACTIVE Building assignment in `clientId` or lacks an
 *    ACTIVE assignment to an explicit `buildingId` filter);
 *  - deterministic keyset pagination on `(createdAt DESC, recordType DESC, recordId DESC)`;
 *  - opt-in `includeCounts` computed over the complete authorized and filtered
 *    result set (never a partial page count).
 */

export function encodeFinanceInboxCursor(
  cursor: HandymanFinanceActionInboxCursor,
): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      recordType: cursor.recordType,
      recordId: cursor.recordId,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeFinanceInboxCursor(
  raw: string,
): HandymanFinanceActionInboxCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as {
      createdAt?: unknown;
      recordType?: unknown;
      recordId?: unknown;
    };
    if (
      typeof parsed?.createdAt !== 'string' ||
      typeof parsed?.recordType !== 'string' ||
      typeof parsed?.recordId !== 'string' ||
      !(
        HANDYMAN_FINANCE_ACTION_INBOX_RECORD_TYPES as readonly string[]
      ).includes(parsed.recordType) ||
      !isValidUuid(parsed.recordId)
    ) {
      throw new Error('bad cursor shape');
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error('bad cursor date');
    }
    return {
      createdAt,
      recordType: parsed.recordType as HandymanFinanceActionInboxRecordType,
      recordId: parsed.recordId,
    };
  } catch {
    throw AppError.validation('Finance action inbox query validation failed.', [
      {
        field: 'cursor',
        message: 'cursor is not a valid finance action inbox continuation token.',
      },
    ]);
  }
}

const ALLOWED_INBOX_QUERY_KEYS = [
  'clientId',
  'buildingId',
  'tenantCompanyId',
  'executionScopeId',
  'handymanRequestId',
  'transactionId',
  'recordType',
  'actionCategory',
  'recordStatus',
  'blockerCode',
  'hasBlocker',
  'responsiblePermission',
  'createdFrom',
  'createdTo',
  'includeCounts',
  'limit',
  'cursor',
] as const;

function readOptionalUuid(
  source: Record<string, unknown>,
  field: string,
  details: Array<{ field: string; message: string }>,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isValidUuid(value)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value;
}

function readOptionalEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  details: Array<{ field: string; message: string }>,
): T | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    details.push({
      field,
      message: `${field} is not a recognized value.`,
    });
    return undefined;
  }
  return value as T;
}

function readOptionalTimestamp(
  source: Record<string, unknown>,
  field: string,
  details: Array<{ field: string; message: string }>,
): Date | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    details.push({
      field,
      message: `${field} must be an ISO-8601 timestamp.`,
    });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 timestamp.`,
    });
    return undefined;
  }
  return parsed;
}

function readOptionalBoolean(
  source: Record<string, unknown>,
  field: string,
  details: Array<{ field: string; message: string }>,
): boolean | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  details.push({
    field,
    message: `${field} must be a boolean ('true' or 'false').`,
  });
  return undefined;
}

function readLimit(
  value: unknown,
  details: Array<{ field: string; message: string }>,
): number {
  if (value === undefined || value === null || value === '') return 20;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    details.push({
      field: 'limit',
      message: 'limit must be an integer between 1 and 100.',
    });
    return 20;
  }
  return parsed;
}

export function parseHandymanFinanceActionInboxQuery(
  rawQuery: unknown,
): HandymanFinanceActionInboxQuery {
  const source =
    typeof rawQuery === 'object' && rawQuery !== null && !Array.isArray(rawQuery)
      ? (rawQuery as Record<string, unknown>)
      : {};
  assertOnlyKeys(source, ALLOWED_INBOX_QUERY_KEYS);

  const details: Array<{ field: string; message: string }> = [];

  const clientId = readOptionalUuid(source, 'clientId', details);
  if (!clientId) {
    if (!details.some((d) => d.field === 'clientId')) {
      details.push({ field: 'clientId', message: 'clientId is required.' });
    }
  }
  const buildingId = readOptionalUuid(source, 'buildingId', details);
  const tenantCompanyId = readOptionalUuid(source, 'tenantCompanyId', details);
  const executionScopeId = readOptionalUuid(source, 'executionScopeId', details);
  const handymanRequestId = readOptionalUuid(
    source,
    'handymanRequestId',
    details,
  );
  const transactionId = readOptionalUuid(source, 'transactionId', details);

  const recordType = readOptionalEnum(
    source,
    'recordType',
    HANDYMAN_FINANCE_ACTION_INBOX_RECORD_TYPES,
    details,
  );
  const actionCategory = readOptionalEnum(
    source,
    'actionCategory',
    HANDYMAN_FINANCE_ACTION_INBOX_CATEGORIES,
    details,
  );
  const recordStatus = readOptionalEnum(
    source,
    'recordStatus',
    HANDYMAN_FINANCE_ACTION_INBOX_RECORD_STATUSES,
    details,
  );
  const blockerCode = readOptionalEnum(
    source,
    'blockerCode',
    HANDYMAN_FINANCE_ACTION_INBOX_BLOCKER_CODES,
    details,
  );
  const hasBlocker = readOptionalBoolean(source, 'hasBlocker', details);
  const responsiblePermission = readOptionalEnum(
    source,
    'responsiblePermission',
    HANDYMAN_FINANCE_ACTION_INBOX_RESPONSIBLE_PERMISSIONS,
    details,
  );
  const createdFrom = readOptionalTimestamp(source, 'createdFrom', details);
  const createdTo = readOptionalTimestamp(source, 'createdTo', details);
  if (
    createdFrom !== undefined &&
    createdTo !== undefined &&
    createdFrom.getTime() > createdTo.getTime()
  ) {
    details.push({
      field: 'createdFrom',
      message: 'createdFrom must not be later than createdTo.',
    });
  }

  const includeCountsOpt = readOptionalBoolean(source, 'includeCounts', details);
  const includeCounts = includeCountsOpt === true;
  const limit = readLimit(source.limit, details);

  let cursor: HandymanFinanceActionInboxCursor | undefined;
  const rawCursor = source.cursor;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    if (typeof rawCursor !== 'string') {
      details.push({
        field: 'cursor',
        message: 'cursor must be a continuation token string.',
      });
    } else {
      cursor = decodeFinanceInboxCursor(rawCursor);
    }
  }

  if (details.length > 0) {
    throw AppError.validation(
      'Finance action inbox query validation failed.',
      details,
    );
  }

  return {
    clientId: clientId as string,
    ...(buildingId ? { buildingId } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(executionScopeId ? { executionScopeId } : {}),
    ...(handymanRequestId ? { handymanRequestId } : {}),
    ...(transactionId ? { transactionId } : {}),
    ...(recordType ? { recordType } : {}),
    ...(actionCategory ? { actionCategory } : {}),
    ...(recordStatus ? { recordStatus } : {}),
    ...(blockerCode ? { blockerCode } : {}),
    ...(hasBlocker !== undefined ? { hasBlocker } : {}),
    ...(responsiblePermission ? { responsiblePermission } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
    includeCounts,
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

export async function listHandymanFinanceActionInbox(
  actorUserId: string,
  query: HandymanFinanceActionInboxQuery,
): Promise<HandymanFinanceActionInboxResult> {
  if (query.buildingId !== undefined) {
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: query.clientId,
      buildingId: query.buildingId,
    });
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, query.clientId))) {
    throw buildingAccessDeniedError();
  }

  const [rows, counts] = await Promise.all([
    handymanFinanceActionInboxRepository.listItems(
      undefined,
      actorUserId,
      query,
    ),
    query.includeCounts
      ? handymanFinanceActionInboxRepository.countItems(
          undefined,
          actorUserId,
          query,
        )
      : Promise.resolve(undefined),
  ]);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeFinanceInboxCursor({
          createdAt: new Date(last.createdAt),
          recordType: last.recordType,
          recordId: last.recordId,
        })
      : null;

  return {
    items,
    pagination: {
      limit: query.limit,
      nextCursor,
      hasMore,
    },
    ...(counts ? { counts } : {}),
  };
}
