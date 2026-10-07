import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  createSaasPricebookHandler,
  createSaasPricebookVersionHandler,
  getSaasPricebookHandler,
  listSaasPricebooksHandler,
  publishSaasPricebookVersionHandler,
} from './platform-pricebook.controller';

/**
 * CR-BE-SAAS-01 PART 02 — versioned SaaS Pricebook endpoints
 * (SaaS Control Plane, frozen contract §22 pricebook subset).
 *
 * Reads (`platform.pricebook.read`):
 *   GET /platform/pricebooks          (list)
 *   GET /platform/pricebooks/:id      (with versions + items)
 * Management (`platform.pricebook.manage`):
 *   POST /platform/pricebooks
 *   POST /platform/pricebooks/:id/versions   (DRAFT version with items[])
 *   POST /platform/pricebook-versions/:id/publish
 *        — Idempotency-Key required (frozen §22 "Idem."), operation key
 *        saas.pricebook.publish; publishes the DRAFT version and supersedes
 *        the previous PUBLISHED version atomically.
 *
 * There is intentionally NO PATCH/DELETE on versions or items: published
 * commercial data is immutable (frozen §10.2), and a DRAFT version is
 * re-created rather than mutated through a separate endpoint surface.
 *
 * Plane boundary: default deny via requirePlatformPermission; no
 * building/organization scoping (frozen §3).
 */
export function createPlatformPricebookRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/pricebooks',
    auth,
    requirePlatformPermission('platform.pricebook.read'),
    listSaasPricebooksHandler,
  );
  router.post(
    '/platform/pricebooks',
    auth,
    requirePlatformPermission('platform.pricebook.manage'),
    createSaasPricebookHandler,
  );
  router.get(
    '/platform/pricebooks/:id',
    auth,
    requirePlatformPermission('platform.pricebook.read'),
    getSaasPricebookHandler,
  );
  router.post(
    '/platform/pricebooks/:id/versions',
    auth,
    requirePlatformPermission('platform.pricebook.manage'),
    createSaasPricebookVersionHandler,
  );
  router.post(
    '/platform/pricebook-versions/:id/publish',
    auth,
    requirePlatformPermission('platform.pricebook.manage'),
    publishSaasPricebookVersionHandler,
  );

  return router;
}
