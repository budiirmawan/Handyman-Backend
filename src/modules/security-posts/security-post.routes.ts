import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createSecurityPostHandler,
  getSecurityPostHandler,
  listBuildingSecurityPostsHandler,
  updateSecurityPostHandler,
} from './security-post.controller';

/**
 * BE-12A — Security Post endpoints.
 *
 *   POST  /buildings/:buildingId/security-posts
 *   GET   /buildings/:buildingId/security-posts
 *   GET   /security/posts/:id
 *   PATCH /security/posts/:id
 *
 * A Security Post is a Security operational master/context record anchored
 * to the existing building digital structure. It does not duplicate any
 * location hierarchy and never carries operational scheduling, routing,
 * execution, or finding semantics (those belong to later BE-12 PARTs).
 *
 * `buildingId` routes are protected by `requireBuildingAccess` (BE-02
 * isolation). The single-id route walks Security Post → Building at read
 * time and asserts the same access there.
 */
export function createSecurityPostRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_post.manage');
  const read = requirePermission('security_post.read');

  router.post(
    '/buildings/:buildingId/security-posts',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createSecurityPostHandler,
  );
  router.get(
    '/buildings/:buildingId/security-posts',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingSecurityPostsHandler,
  );
  router.get(
    '/security/posts/:id',
    auth,
    read,
    getSecurityPostHandler,
  );
  router.patch(
    '/security/posts/:id',
    auth,
    manage,
    updateSecurityPostHandler,
  );

  return router;
}
