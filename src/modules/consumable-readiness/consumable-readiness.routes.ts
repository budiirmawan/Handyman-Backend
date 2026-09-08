import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createConsumableRequirementHandler,
  getConsumableRequirementHandler,
  listConsumableReadinessHandler,
  listConsumableRequirementsHandler,
  recordConsumableReadinessHandler,
  updateConsumableRequirementHandler,
} from './consumable-readiness.controller';

/**
 * BE-11J — Consumable Readiness endpoints.
 *
 *   POST  /housekeeping/consumable-requirements
 *   GET   /housekeeping/consumable-requirements
 *   GET   /housekeeping/consumable-requirements/:id
 *   PATCH /housekeeping/consumable-requirements/:id
 *   POST  /housekeeping/consumable-requirements/:id/readiness
 *   GET   /housekeeping/consumable-readiness
 */
export function createConsumableReadinessRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('consumable_readiness.manage');
  const read = requirePermission('consumable_readiness.read');

  router.post(
    '/housekeeping/consumable-requirements',
    auth,
    manage,
    createConsumableRequirementHandler,
  );
  router.get(
    '/housekeeping/consumable-requirements',
    auth,
    read,
    listConsumableRequirementsHandler,
  );
  router.get(
    '/housekeeping/consumable-requirements/:id',
    auth,
    read,
    getConsumableRequirementHandler,
  );
  router.patch(
    '/housekeeping/consumable-requirements/:id',
    auth,
    manage,
    updateConsumableRequirementHandler,
  );
  router.post(
    '/housekeeping/consumable-requirements/:id/readiness',
    auth,
    manage,
    recordConsumableReadinessHandler,
  );
  router.get(
    '/housekeeping/consumable-readiness',
    auth,
    read,
    listConsumableReadinessHandler,
  );

  return router;
}
