import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getHistoryItemHandler,
  listHistoryHandler,
} from './notification-history.controller';

/**
 * BE-26K — Notification history (read model).
 *
 *   GET /notification-history
 *   GET /notification-history/:channel/:historyId
 *
 * Authenticated, self-scoped reads of the recipient's own delivery history
 * across IN_APP / EMAIL / WHATSAPP channels. Read-only — no create/update/
 * delete endpoints.
 */
export function createNotificationHistoryRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get('/notification-history', auth, listHistoryHandler);
  router.get('/notification-history/:channel/:historyId', auth, getHistoryItemHandler);

  return router;
}
