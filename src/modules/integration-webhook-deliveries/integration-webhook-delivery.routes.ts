import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { authenticationRequiredError } from '../auth';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import {
  getIntegrationWebhookDeliveryById,
  listIntegrationWebhookDeliveries,
} from './integration-webhook-delivery.read.service';
import {
  isIntegrationWebhookDeliveryStatus,
  type IntegrationWebhookDeliveryListFilters,
} from './integration-webhook-delivery.types';

/**
 * CR-BE-INTEG-01 PART 06 — delivery history read surface (governance §11).
 *
 *   GET /integration/webhook-deliveries       integration_webhook.read
 *   GET /integration/webhook-deliveries/:id   integration_webhook.read
 *
 * READ-ONLY: no manual retry, no manual event injection, no payload access
 * (§11 exclusions stand). RBAC default-deny + BE-02G Client scope on every
 * request. Optional filters: clientId, endpointId, status, eventType,
 * from/to (created window). Shared opt-in pagination (page/pageSize).
 */

const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

type Detail = { field: string; message: string };

function one(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function parseFilters(query: Record<string, unknown>): IntegrationWebhookDeliveryListFilters {
  const details: Detail[] = [];
  const filters: IntegrationWebhookDeliveryListFilters = {};

  for (const field of ['clientId', 'endpointId'] as const) {
    const value = one(query[field]);
    if (value !== undefined) {
      if (typeof value !== 'string' || !isValidUuid(value)) {
        details.push({ field, message: `${field} must be a valid UUID.` });
      } else {
        filters[field] = value.trim().toLowerCase();
      }
    }
  }

  const status = one(query.status);
  if (status !== undefined) {
    if (!isIntegrationWebhookDeliveryStatus(status)) {
      details.push({
        field: 'status',
        message:
          'status must be one of PENDING, SENDING, DELIVERED, RETRY_SCHEDULED, FAILED_PERMANENT, EXHAUSTED.',
      });
    } else {
      filters.status = status;
    }
  }

  const eventType = one(query.eventType);
  if (eventType !== undefined) {
    if (typeof eventType !== 'string' || !EVENT_TYPE_PATTERN.test(eventType.trim())) {
      details.push({
        field: 'eventType',
        message: 'eventType must be a code (letters, digits, underscore).',
      });
    } else {
      filters.eventType = eventType.trim().toUpperCase();
    }
  }

  for (const field of ['from', 'to'] as const) {
    const value = one(query[field]);
    if (value !== undefined) {
      const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
      if (Number.isNaN(parsed.getTime())) {
        details.push({ field, message: `${field} must be an ISO 8601 timestamp.` });
      } else {
        filters[field] = parsed;
      }
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return filters;
}

async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    if (hasPaginationParams(req.query as Record<string, unknown>)) {
      const page = parsePagination(req.query as Record<string, unknown>);
      const { rows, total } = await listIntegrationWebhookDeliveries(
        filters,
        userId(req),
        { limit: page.limit, offset: page.offset },
      );
      sendSuccess(res, rows, 200, buildPaginationMeta(page.page, page.pageSize, total));
      return;
    }
    const { rows } = await listIntegrationWebhookDeliveries(filters, userId(req));
    sendSuccess(res, rows);
  } catch (error) {
    next(error);
  }
}

async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (typeof raw !== 'string' || !isValidUuid(raw)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'id', message: 'id must be a valid UUID.' },
      ]);
    }
    sendSuccess(
      res,
      await getIntegrationWebhookDeliveryById(raw.trim().toLowerCase(), userId(req)),
    );
  } catch (error) {
    next(error);
  }
}

export function createIntegrationWebhookDeliveryRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('integration_webhook.read');

  router.get('/integration/webhook-deliveries', auth, read, listHandler);
  router.get('/integration/webhook-deliveries/:id', auth, read, getHandler);

  return router;
}
