import { Router, type NextFunction, type Request, type Response } from 'express';
import { getPool } from '../../database';
import { sanitizeHistoryMetadata } from '../asset-history/asset-history.metadata';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import { isValidUuid } from '../clients';

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Control-Plane audit read (frozen §18.3).
 *
 * Reads the SINGLE canonical audit store (`operational_events`) — no second
 * SaaS audit table (frozen D1). Platform scope: the read is governed by the
 * explicit `platform.audit.read` permission ONLY. It deliberately does NOT
 * apply the business-plane building/client data scope — a platform auditor
 * is cross-customer by authority (frozen §3), and platform-scope events
 * (NULL client_id) are invisible to every business-plane read.
 *
 * The business-plane `GET /operational-events` is untouched: it stays
 * `operational_event.read` + BE-02G scoped.
 */

const EVENT_COLUMNS = `
  id,
  client_id,
  event_type,
  entity_type,
  entity_id,
  actor_user_id,
  building_id,
  request_id,
  source,
  summary,
  metadata,
  occurred_at,
  created_at
`;

type EventRow = {
  id: string;
  client_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string | null;
  building_id: string | null;
  request_id: string | null;
  source: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
};

type Filters = {
  customerId?: string;
  actorUserId?: string;
  eventType?: string;
  entityType?: string;
  from?: Date;
  to?: Date;
};

function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(
  details: { field: string; message: string }[],
): never {
  throw AppError.validation('Request validation failed.', details);
}

function optionalUuid(
  value: unknown,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    details.push({ field, message: `${field} must be a single UUID value.` });
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | undefined {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    details.push({ field, message: `${field} must be a single string value.` });
    return undefined;
  }
  const normalized = raw.trim();
  if (normalized.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return normalized;
}

function optionalDate(
  value: unknown,
  field: string,
  details: { field: string; message: string }[],
): Date | undefined {
  const raw = optionalText(value, field, 64, details);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO date-time.` });
    return undefined;
  }
  return parsed;
}

function parseFilters(query: Record<string, unknown>): Filters {
  const details: { field: string; message: string }[] = [];
  const filters: Filters = {};

  const customerId = optionalUuid(query.customerId, 'customerId', details);
  if (customerId !== undefined) filters.customerId = customerId;

  const actorUserId = optionalUuid(query.actorUserId, 'actorUserId', details);
  if (actorUserId !== undefined) filters.actorUserId = actorUserId;

  const eventType = optionalText(query.eventType, 'eventType', 128, details);
  if (eventType !== undefined) filters.eventType = eventType;

  const entityType = optionalText(query.entityType, 'entityType', 128, details);
  if (entityType !== undefined) filters.entityType = entityType;

  const from = optionalDate(query.from, 'from', details);
  if (from !== undefined) filters.from = from;
  const to = optionalDate(query.to, 'to', details);
  if (to !== undefined) filters.to = to;
  if (from && to && from > to) {
    details.push({ field: 'from', message: 'from must not be after to.' });
  }

  if (details.length > 0) {
    validationError(details);
  }
  return filters;
}

function mapRow(row: EventRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    buildingId: row.building_id,
    requestId: row.request_id ?? null,
    source: row.source ?? null,
    summary: row.summary,
    metadata: sanitizeHistoryMetadata(row.metadata),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

async function listPlatformAuditHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const clauses: string[] = [];
    const params: unknown[] = [];

    const add = (clause: string, value: unknown): void => {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    };

    if (filters.customerId) add('client_id = ?', filters.customerId);
    if (filters.actorUserId) add('actor_user_id = ?', filters.actorUserId);
    if (filters.eventType) add('event_type = ?', filters.eventType);
    if (filters.entityType) add('entity_type = ?', filters.entityType);
    if (filters.from) add('occurred_at >= ?', filters.from);
    if (filters.to) add('occurred_at <= ?', filters.to);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    let total = 0;
    if (usePagination) {
      const totalResult = await getPool().query<{ total: number }>(
        `SELECT count(*)::int AS total FROM operational_events ${where}`,
        params,
      );
      total = totalResult.rows[0]?.total ?? 0;
    }

    const listParams = usePagination
      ? [...params, pagination.limit, pagination.offset]
      : params;
    const limitClause = usePagination
      ? `LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`
      : '';

    const result = await getPool().query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM operational_events
         ${where}
        ORDER BY occurred_at DESC, id DESC
        ${limitClause}`,
      listParams,
    );

    sendSuccess(
      res,
      result.rows.map(mapRow),
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, total)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

export function createPlatformAuditRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/audit',
    auth,
    requirePlatformPermission('platform.audit.read'),
    listPlatformAuditHandler,
  );

  return router;
}
