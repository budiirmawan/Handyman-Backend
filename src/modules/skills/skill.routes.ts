import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSkillHandler,
  getSkillHandler,
  listClientSkillsHandler,
} from './skill.controller';

/**
 * BE-03D1 — Skill catalog endpoints, protected by BE-01 RBAC.
 *
 * Reads (`skill.read`): GET /clients/:clientId/skills, GET /skills/:id.
 * Management (`skill.manage`): POST /clients/:clientId/skills.
 *
 * Writes and Client-scoped reads are nested under the Client so the owning
 * Client is always taken from the URL (BE-02 isolation).
 */
export function createSkillRouter(): Router {
  const router = Router();

  router.post(
    '/clients/:clientId/skills',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    createSkillHandler,
  );
  router.get(
    '/clients/:clientId/skills',
    authenticationMiddleware,
    requirePermission('skill.read'),
    listClientSkillsHandler,
  );
  router.get(
    '/skills/:id',
    authenticationMiddleware,
    requirePermission('skill.read'),
    getSkillHandler,
  );

  return router;
}
