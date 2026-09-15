import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignWorkforceSkillHandler,
  listEffectiveWorkforceSkillsHandler,
  listWorkforceSkillsHandler,
  updateWorkforceSkillHandler,
} from './workforce-skill.controller';

/**
 * BE-03D2 / BE-03D3 — Workforce Skill Assignment and effective Skill
 * resolution endpoints, protected by BE-01 RBAC.
 *
 * Reuses the BE-03D1 Skill permissions rather than introducing new codes:
 *   `skill.read`   → GET    /workforce/:workforceId/skills
 *                    GET    /workforce/:workforceId/skills/effective
 *   `skill.manage` → POST   /workforce/:workforceId/skills
 *                    PATCH  /workforce/:workforceId/skills/:skillId
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so the
 * competency history survives.
 */
export function createWorkforceSkillRouter(): Router {
  const router = Router();

  router.post(
    '/workforce/:workforceId/skills',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    assignWorkforceSkillHandler,
  );
  router.get(
    '/workforce/:workforceId/skills',
    authenticationMiddleware,
    requirePermission('skill.read'),
    listWorkforceSkillsHandler,
  );
  // Registered before the `:skillId` routes so the literal segment always
  // wins, even though the differing HTTP verbs already keep them apart.
  router.get(
    '/workforce/:workforceId/skills/effective',
    authenticationMiddleware,
    requirePermission('skill.read'),
    listEffectiveWorkforceSkillsHandler,
  );
  router.patch(
    '/workforce/:workforceId/skills/:skillId',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    updateWorkforceSkillHandler,
  );

  return router;
}
