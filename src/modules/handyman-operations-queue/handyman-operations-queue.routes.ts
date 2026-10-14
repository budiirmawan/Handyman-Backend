import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  listHandymanOperationsCommercialInboxHandler,
  listHandymanOperationsQueueHandler,
} from './handyman-operations-queue.controller';

/**
 * Production read-only Handyman Operations surfaces.
 *
 * - `/handyman/operations/queue` — request-keyed lifecycle queue.
 *   CR-HM-OPS-INBOX-BE-01 P0-A: discovery within the genuine Operations
 *   Client/Building scope (explicit ACTIVE Building assignment under the
 *   queried Client); Tenant PIC membership is NOT required.
 * - `/handyman/operations/commercial-inbox` — CR-HM-OPS-INBOX-BE-01 P0-B:
 *   authoritative, paginated commercial discovery over the existing Variation
 *   and Material Purchasing records. Read authority only; the route reuses
 *   the same `tenant_company.read` permission and never exposes records
 *   outside the actor's Building assignments.
 */
export function createHandymanOperationsQueueRouter(): Router {
  const router = Router();
  router.get(
    '/handyman/operations/queue',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listHandymanOperationsQueueHandler,
  );
  router.get(
    '/handyman/operations/commercial-inbox',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listHandymanOperationsCommercialInboxHandler,
  );
  return router;
}
