import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTeamHandler,
  getTeamHandler,
  listTeamsHandler,
  updateTeamHandler,
} from './team.controller';

/**
 * Team management endpoints, protected by RBAC.
 *
 * Reads (`team.read`):  GET /departments/:departmentId/teams, GET /teams/:id.
 * Management (`team.manage`): POST /departments/:departmentId/teams, PATCH /teams/:id.
 *
 * All team lists are scoped to a department via the route parameter.
 */
export function createTeamRouter(): Router {
  const router = Router();

  // Nest teams under departments for hierarchical routing
  router.post(
    '/departments/:departmentId/teams',
    authenticationMiddleware,
    requirePermission('team.manage'),
    createTeamHandler,
  );

  router.get(
    '/departments/:departmentId/teams',
    authenticationMiddleware,
    requirePermission('team.read'),
    listTeamsHandler,
  );

  router.get(
    '/teams/:id',
    authenticationMiddleware,
    requirePermission('team.read'),
    getTeamHandler,
  );

  router.patch(
    '/teams/:id',
    authenticationMiddleware,
    requirePermission('team.manage'),
    updateTeamHandler,
  );

  return router;
}
