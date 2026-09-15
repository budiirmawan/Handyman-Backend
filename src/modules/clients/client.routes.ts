import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createClientHandler,
  getClientHandler,
  listClientsHandler,
  updateClientHandler,
} from './client.controller';

/**
 * Client (Company & Client) management endpoints, protected by RBAC.
 *
 * Reads (`client.read`): GET /clients, GET /clients/:id.
 * Management (`client.manage`): POST /clients, PATCH /clients/:id.
 */
export function createClientRouter(): Router {
  const router = Router();

  router.post(
    '/clients',
    authenticationMiddleware,
    requirePermission('client.manage'),
    createClientHandler,
  );
  router.get(
    '/clients',
    authenticationMiddleware,
    requirePermission('client.read'),
    listClientsHandler,
  );
  router.get(
    '/clients/:id',
    authenticationMiddleware,
    requirePermission('client.read'),
    getClientHandler,
  );
  router.patch(
    '/clients/:id',
    authenticationMiddleware,
    requirePermission('client.manage'),
    updateClientHandler,
  );

  return router;
}
