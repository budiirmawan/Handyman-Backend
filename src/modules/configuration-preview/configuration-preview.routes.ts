import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  createConfigurationPreviewHandler,
  getConfigurationPreviewHandler,
  getEffectiveConfigurationPreviewHandler,
  revokeConfigurationPreviewHandler,
} from './configuration-preview.controller';

/** BE-27P caller-bound preview contexts; no ACTIVE state mutation. */
export function createConfigurationPreviewRouter(): Router {
  const router = Router();
  router.post(
    '/configuration-versions/:versionId/preview-contexts',
    authenticationMiddleware,
    createConfigurationPreviewHandler,
  );
  router.get(
    '/configuration-preview-contexts/:id',
    authenticationMiddleware,
    getConfigurationPreviewHandler,
  );
  router.get(
    '/configuration-preview-contexts/:id/effective',
    authenticationMiddleware,
    getEffectiveConfigurationPreviewHandler,
  );
  router.post(
    '/configuration-preview-contexts/:id/revoke',
    authenticationMiddleware,
    revokeConfigurationPreviewHandler,
  );
  return router;
}
