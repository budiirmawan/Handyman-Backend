import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { getPool } from '../../database';
import { sanitizeHistoryMetadata } from '../asset-history/asset-history.metadata';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import {
  buildPaginationMeta,
  parsePagination,
} from '../../shared/pagination';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  OPERATIONAL_EVENT_SOURCES,
  type OperationalEventRecord,
  type OperationalEventSource,
} from './index';

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

type OperationalEventFilters = {
  clientId?: string;
  buildingId?: string;
  actorUserId?: string;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  source?: OperationalEventSource;
  from?: Date;
  to?: Date;
};

type OperationalEventRow = Pick<
  OperationalEventRecord,
  | 'id'
  | 'client_id'
  | 'event_type'
  | 'entity_type'
  | 'entity_id'
  | 'actor_user_id'
  | 'building_id'
  | 'request_id'
  | 'source'
  | 'summary'
  | 'metadata'
  | 'occurred_at'
  | 'created_at'
>;

type AccessibleScope = {
  buildingIds: string[];
  clientIds: string[];
};

type ValidationDetail = { field: string; message: string };

function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function optionalText(
  value: unknown,
  field: string,
  details: ValidationDetail[],
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
  if (!normalized) return undefined;
  if (normalized.length > 128) {
    details.push({ field, message: `${field} must be at most 128 characters.` });
    return undefined;
  }
  return normalized;
}

function optionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = optionalText(value, field, details);
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (!isValidUuid(normalized)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return normalized;
}

function optionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const raw = optionalText(value, field, details);
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO date-time.` });
    return undefined;
  }
  return parsed;
}

function parseFilters(query: Record<string, unknown>): OperationalEventFilters {
  const details: ValidationDetail[] = [];
  const filters: OperationalEventFilters = {};

  for (const field of [
    'clientId',
    'buildingId',
    'actorUserId',
    'entityId',
    'requestId',
  ] as const) {
    const value = optionalUuid(query[field], field, details);
    if (value !== undefined) filters[field] = value;
  }

  for (const field of ['eventType', 'entityType'] as const) {
    const value = optionalText(query[field], field, details);
    if (value !== undefined) filters[field] = value;
  }

  const source = optionalText(query.source, 'source', details)?.toUpperCase();
  if (source !== undefined) {
    if (!(OPERATIONAL_EVENT_SOURCES as readonly string[]).includes(source)) {
      details.push({
        field: 'source',
        message: `source must be one of: ${OPERATIONAL_EVENT_SOURCES.join(', ')}.`,
      });
    } else {
      filters.source = source as OperationalEventSource;
    }
  }

  const from = optionalDate(query.from, 'from', details);
  const to = optionalDate(query.to, 'to', details);
  if (from !== undefined) filters.from = from;
  if (to !== undefined) filters.to = to;
  if (from && to && from > to) {
    details.push({ field: 'from', message: 'from must not be after to.' });
  }

  if (details.length > 0) validationError(details);
  return filters;
}

function mapRow(row: OperationalEventRow) {
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

async function accessibleScope(userId: string): Promise<AccessibleScope> {
  const [buildingIds, clientIds] = await Promise.all([
    contextAccessService.getAccessibleBuildingIds(userId),
    contextAccessService.getAccessibleClientIds(userId),
  ]);
  return { buildingIds, clientIds };
}

function assertRequestedScope(
  filters: OperationalEventFilters,
  scope: AccessibleScope,
): void {
  if (filters.clientId && !scope.clientIds.includes(filters.clientId)) {
    throw buildingAccessDeniedError();
  }
  if (filters.buildingId && !scope.buildingIds.includes(filters.buildingId)) {
    throw buildingAccessDeniedError();
  }
}

function buildWhere(
  filters: OperationalEventFilters,
  scope: AccessibleScope,
): { clause: string; params: unknown[] } {
  const clauses = [
    '(building_id = ANY($1::uuid[]) OR (building_id IS NULL AND client_id = ANY($2::uuid[])))',
  ];
  const params: unknown[] = [scope.buildingIds, scope.clientIds];

  const add = (clause: string, value: unknown): void => {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  };

  if (filters.clientId) add('client_id = ?', filters.clientId);
  if (filters.buildingId) add('building_id = ?', filters.buildingId);
  if (filters.actorUserId) add('actor_user_id = ?', filters.actorUserId);
  if (filters.eventType) add('event_type = ?', filters.eventType);
  if (filters.entityType) add('entity_type = ?', filters.entityType);
  if (filters.entityId) add('entity_id = ?', filters.entityId);
  if (filters.requestId) add('request_id = ?', filters.requestId);
  if (filters.source) add('source = ?', filters.source);
  if (filters.from) add('occurred_at >= ?', filters.from);
  if (filters.to) add('occurred_at <= ?', filters.to);

  return { clause: clauses.join(' AND '), params };
}

async function findScopedEvent(
  id: string,
  scope: AccessibleScope,
): Promise<OperationalEventRow | null> {
  const result = await getPool().query<OperationalEventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM operational_events
      WHERE id = $1
        AND (building_id = ANY($2::uuid[])
          OR (building_id IS NULL AND client_id = ANY($3::uuid[])))`,
    [id, scope.buildingIds, scope.clientIds],
  );
  return result.rows[0] ?? null;
}

async function getOperationalEventHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawId = firstQueryValue(req.params.id);
    if (typeof rawId !== 'string' || !isValidUuid(rawId.trim())) {
      validationError([{ field: 'id', message: 'id must be a valid UUID.' }]);
    }
    const scope = await accessibleScope(req.auth.userId);
    const row = await findScopedEvent(rawId.trim().toLowerCase(), scope);
    // Scope is part of the SQL predicate: inaccessible events are intentionally
    // indistinguishable from unknown events at this enterprise read boundary.
    if (!row) throw AppError.notFound('Operational event not found.');
    sendSuccess(res, mapRow(row));
  } catch (error) {
    next(error);
  }
}

async function listOperationalEventHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const scope = await accessibleScope(req.auth.userId);
    assertRequestedScope(filters, scope);
    const where = buildWhere(filters, scope);
    const pagination = parsePagination(req.query as Record<string, unknown>);

    const totalResult = await getPool().query<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM operational_events
        WHERE ${where.clause}`,
      where.params,
    );
    const params = [...where.params, pagination.limit, pagination.offset];
    const result = await getPool().query<OperationalEventRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM operational_events
        WHERE ${where.clause}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );

    sendSuccess(
      res,
      result.rows.map(mapRow),
      200,
      buildPaginationMeta(
        pagination.page,
        pagination.pageSize,
        totalResult.rows[0]?.total ?? 0,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export function createOperationalEventRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('operational_event.read');
  router.get('/operational-events', auth, read, listOperationalEventHandler);
  router.get('/operational-events/:id', auth, read, getOperationalEventHandler);
  return router;
}
