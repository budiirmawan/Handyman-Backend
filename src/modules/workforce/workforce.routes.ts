import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createWorkforceProfileHandler,
  getWorkforceProfileHandler,
  listWorkforceProfilesByDeptHandler,
  listWorkforceProfilesByOrgHandler,
  listWorkforceProfilesByTeamHandler,
  updateWorkforceProfileHandler,
} from './workforce.controller';

/**
 * Workforce Profile endpoints, protected by RBAC.
 *
 * Reads (`workforce.read`):
 *   GET /organizations/:organizationId/workforce-profiles
 *   GET /departments/:departmentId/workforce-profiles
 *   GET /teams/:teamId/workforce-profiles
 *   GET /workforce-profiles/:id
 *
 * Management (`workforce.manage`):
 *   POST  /organizations/:organizationId/workforce-profiles
 *   PATCH /workforce-profiles/:id
 *
 * A Workforce Profile is operational personnel identity, not a User account.
 * Creating or linking one never creates credentials and never alters BE-01 RBAC.
 */
export function createWorkforceRouter(): Router {
  const router = Router();

  router.post(
    '/organizations/:organizationId/workforce-profiles',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    createWorkforceProfileHandler,
  );

  router.get(
    '/organizations/:organizationId/workforce-profiles',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceProfilesByOrgHandler,
  );

  router.get(
    '/departments/:departmentId/workforce-profiles',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceProfilesByDeptHandler,
  );

  router.get(
    '/teams/:teamId/workforce-profiles',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceProfilesByTeamHandler,
  );

  router.get(
    '/workforce-profiles/:id',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    getWorkforceProfileHandler,
  );

  router.patch(
    '/workforce-profiles/:id',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    updateWorkforceProfileHandler,
  );

  return router;
}
