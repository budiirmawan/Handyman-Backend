import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelHandymanRequestHandler,
  createHandymanRequestHandler,
  getHandymanRequestHandler,
  listBuildingHandymanRequestsHandler,
} from './handyman-request.controller';

/**
 * CR-HM-BE-01 RUN 3 — Handyman Request HTTP contract.
 *
 *   POST /buildings/:buildingId/handyman-requests
 *   GET  /buildings/:buildingId/handyman-requests
 *   GET  /handyman-requests/:handymanRequestId
 *   POST /handyman-requests/:handymanRequestId/cancel
 *
 * Thin exposure of the completed Run 1–2 authority through the existing Asentra
 * route composition. Building access enforcement and every business rule stay
 * in the Run 2 service; no separate Handyman server/runtime exists.
 */
export function createHandymanRequestRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_request.read');

  router.post(
    '/buildings/:buildingId/handyman-requests',
    auth,
    requirePermission('handyman_request.create'),
    createHandymanRequestHandler,
  );
  router.get(
    '/buildings/:buildingId/handyman-requests',
    auth,
    read,
    listBuildingHandymanRequestsHandler,
  );
  router.get(
    '/handyman-requests/:handymanRequestId',
    auth,
    read,
    getHandymanRequestHandler,
  );
  router.post(
    '/handyman-requests/:handymanRequestId/cancel',
    auth,
    requirePermission('handyman_request.manage'),
    cancelHandymanRequestHandler,
  );

  return router;
}
