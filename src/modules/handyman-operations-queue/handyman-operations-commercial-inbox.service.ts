import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  HANDYMAN_MATERIAL_PURCHASE_STATUSES,
} from '../handyman-material-purchasing';
import {
  HANDYMAN_SCOPE_VARIATION_STATUSES,
} from '../handyman-scope-variations';
import { handymanOperationsCommercialInboxRepository } from './handyman-operations-commercial-inbox.repository';
import type {
  HandymanCommercialInboxCursor,
  HandymanCommercialInboxPage,
  HandymanCommercialInboxQuery,
  HandymanCommercialInboxRecordType,
  HandymanCommercialInboxResponsiblePersona,
} from './handyman-operations-commercial-inbox.types';
import {
  HANDYMAN_COMMERCIAL_INBOX_RECORD_TYPES,
  HANDYMAN_COMMERCIAL_INBOX_RESPONSIBLE_PERSONAS,
} from './handyman-operations-commercial-inbox.types';

/**
 * CR-HM-OPS-INBOX-BE-01 P0-B — authoritative commercial action inbox.
 *
 * Read-only discovery over the existing Variation and Material Purchasing
 * records within the actor's genuine Client/Building scope. This is
 * discovery/read authority ONLY: it never mutates, never re-decides, and
 * never impersonates another persona — variation approval and tenant
 * decisions, purchasing/expense authority, QC/BAST, invoice/finance,
 * evidence verification and dispatch assignment all stay with their own
 * governed surfaces and actors.
 *
 * Authorization (before any record is exposed):
 *   1. route-level `tenant_company.read` permission (RBAC middleware);
 *   2. an explicit `buildingId` filter must be the actor's exact assignment
 *      under the queried Client (same-Client sibling Buildings: 403);
 *   3. the queried Client must be reachable through one of the actor's
 *      assignments (unreachable Client: 403, no existence leak);
 *   4. per-row BE-02G assignment wall inside the repository statement, so
 *      only genuinely in-scope records can ever leave the database.
 */

const CURSOR_LIMIT_BOUNDS = { min: 1, max: 100, defaultValue: 20 };

function isRecordType(value: string): value is HandymanCommercialInboxRecordType {
  return (HANDYMAN_COMMERCIAL_INBOX_RECORD_TYPES as readonly string[]).includes(value);
}

function isResponsiblePersona(
  value: string,
): value is HandymanCommercialInboxResponsiblePersona {
  return (HANDYMAN_COMMERCIAL_INBOX_RESPONSIBLE_PERSONAS as readonly string[]).includes(value);
}

function isKnownCommercialStatus(value: string): boolean {
  return (HANDYMAN_SCOPE_VARIATION_STATUSES as readonly string[]).includes(value) ||
    (HANDYMAN_MATERIAL_PURCHASE_STATUSES as readonly string[]).includes(value);
}

function validationError(details: Array<{ field: string; message: string }>): AppError {
  return AppError.validation('Commercial inbox query validation failed.', details);
}

function parseTimestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError([
      { field, message: `${field} must be an ISO-8601 timestamp.` },
    ]);
  }
  return parsed;
}

/**
 * Explicit continuation contract: the cursor is the opaque encoding of the
 * last record's deterministic sort key
 * `(createdAt, recordType, recordId)`. It carries no session or filter
 * state; a continuation MUST be issued with the same filters, or the
 * walk simply continues in the new filter's own key order. A malformed
 * cursor is a client error (400), never a silent page restart.
 */
function encodeCursor(cursor: HandymanCommercialInboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): HandymanCommercialInboxCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw validationError([
      { field: 'cursor', message: 'cursor is not a valid continuation token.' },
    ]);
  }
  const candidate = parsed as Partial<HandymanCommercialInboxCursor> | null;
  if (
    !candidate ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.recordType !== 'string' ||
    typeof candidate.recordId !== 'string' ||
    !isRecordType(candidate.recordType) ||
    !isValidUuid(candidate.recordId) ||
    Number.isNaN(new Date(candidate.createdAt).getTime())
  ) {
    throw validationError([
      { field: 'cursor', message: 'cursor is not a valid continuation token.' },
    ]);
  }
  return {
    createdAt: candidate.createdAt,
    recordType: candidate.recordType,
    recordId: candidate.recordId,
  };
}

export async function listHandymanOperationsCommercialInbox(
  actorUserId: string,
  query: HandymanCommercialInboxQuery,
): Promise<HandymanCommercialInboxPage> {
  if (!isValidUuid(query.clientId)) {
    throw validationError([
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  if (query.buildingId !== undefined && !isValidUuid(query.buildingId)) {
    throw validationError([
      { field: 'buildingId', message: 'buildingId must be a valid UUID.' },
    ]);
  }
  if (
    query.tenantCompanyId !== undefined &&
    !isValidUuid(query.tenantCompanyId)
  ) {
    throw validationError([
      {
        field: 'tenantCompanyId',
        message: 'tenantCompanyId must be a valid UUID.',
      },
    ]);
  }
  if (
    query.status !== undefined &&
    !isKnownCommercialStatus(query.status)
  ) {
    throw validationError([
      {
        field: 'status',
        message:
          'status is not a recognized repository-native commercial status.',
      },
    ]);
  }
  if (
    query.limit < CURSOR_LIMIT_BOUNDS.min ||
    query.limit > CURSOR_LIMIT_BOUNDS.max
  ) {
    throw validationError([
      {
        field: 'limit',
        message: `limit must be an integer between ${CURSOR_LIMIT_BOUNDS.min} and ${CURSOR_LIMIT_BOUNDS.max}.`,
      },
    ]);
  }

  if (query.buildingId !== undefined) {
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: query.clientId,
      buildingId: query.buildingId,
    });
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, query.clientId))) {
    throw buildingAccessDeniedError();
  }

  const selection = {
    ...query,
    actorUserId,
  } as HandymanCommercialInboxQuery & { actorUserId: string };

  const page = await handymanOperationsCommercialInboxRepository
    .listCommercialInboxPage(undefined, selection, query.limit);

  const hasMore = page.hasMore;
  const last = page.rows[page.rows.length - 1];
  const items = page.rows.map(handymanOperationsCommercialInboxRepository.toInboxItem);

  const result: HandymanCommercialInboxPage = {
    items,
    pagination: {
      limit: query.limit,
      nextCursor: hasMore && last
        ? encodeCursor({
            createdAt: last.createdAt.toISOString(),
            recordType: last.recordType,
            recordId: last.recordId,
          })
        : null,
      hasMore,
    },
  };

  if (query.includeCounts) {
    // Always computed over the COMPLETE permitted result set — never over
    // the loaded page — so a partially loaded page is never labeled a total.
    result.counts =
      await handymanOperationsCommercialInboxRepository.countCommercialInbox(
        undefined,
        selection,
      );
  }

  return result;
}

export const handymanOperationsCommercialInboxCodec = {
  encodeCursor,
  decodeCursor,
};
